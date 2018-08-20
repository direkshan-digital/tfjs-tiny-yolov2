import * as tf from '@tensorflow/tfjs-core';

import { BoundingBox } from '../BoundingBox';
import { convLayer } from '../commons/convLayer';
import { NeuralNetwork } from '../commons/NeuralNetwork';
import { nonMaxSuppression } from '../commons/nonMaxSuppression';
import { normalize } from '../commons/normalize';
import { NetInput } from '../NetInput';
import { ObjectDetection } from '../ObjectDetection';
import { toNetInput } from '../toNetInput';
import { Dimensions, TNetInput } from '../types';
import { sigmoid } from '../utils';
import { assignGroundTruthToAnchors } from './assignBoxesToAnchors';
import { computeBoxAdjustments } from './computeBoxAdjustments';
import { computeIous } from './computeIous';
import { TinyYolov2Config, validateConfig, validateTrainConfig } from './config';
import { INPUT_SIZES } from './const';
import { convWithBatchNorm } from './convWithBatchNorm';
import { createCoordAndScoreMasks } from './createCoordAndScoreMasks';
import { createGroundTruthMask } from './createGroundTruthMask';
import { createOneHotClassScoreMask } from './createOneHotClassScoreMask';
import { extractParams } from './extractParams';
import { getDefaultParams } from './getDefaultParams';
import { loadQuantizedParams } from './loadQuantizedParams';
import { GroundTruth, GroundTruthWithGridPosition, NetParams, TinyYolov2ForwardParams } from './types';

export class TinyYolov2 extends NeuralNetwork<NetParams> {

  private _config: TinyYolov2Config

  constructor(config: TinyYolov2Config) {
    super('TinyYolov2')
    validateConfig(config)
    this._config = config
  }

  public get config(): TinyYolov2Config {
    return this._config
  }

  public get withClassScores(): boolean {
    return this.config.withClassScores || this.config.classes.length > 1
  }

  public get boxEncodingSize(): number{
    return 5 + (this.withClassScores ? this.config.classes.length : 0)
  }

  public forwardInput(input: NetInput, inputSize: number): tf.Tensor4D {

    const { params } = this

    if (!params) {
      throw new Error('TinyYolov2 - load model before inference')
    }

    const out = tf.tidy(() => {

      let batchTensor = input.toBatchTensor(inputSize, false)
      batchTensor = this.config.meanRgb
        ? normalize(batchTensor, this.config.meanRgb)
        : batchTensor
      batchTensor = batchTensor.div(tf.scalar(256)) as tf.Tensor4D

      let out = convWithBatchNorm(batchTensor, params.conv0)
      out = tf.maxPool(out, [2, 2], [2, 2], 'same')
      out = convWithBatchNorm(out, params.conv1)
      out = tf.maxPool(out, [2, 2], [2, 2], 'same')
      out = convWithBatchNorm(out, params.conv2)
      out = tf.maxPool(out, [2, 2], [2, 2], 'same')
      out = convWithBatchNorm(out, params.conv3)
      out = tf.maxPool(out, [2, 2], [2, 2], 'same')
      out = convWithBatchNorm(out, params.conv4)
      out = tf.maxPool(out, [2, 2], [2, 2], 'same')
      out = convWithBatchNorm(out, params.conv5)
      out = tf.maxPool(out, [2, 2], [1, 1], 'same')
      out = convWithBatchNorm(out, params.conv6)
      out = convWithBatchNorm(out, params.conv7)
      out = convLayer(out, params.conv8, 'valid', false)

      return out
    })

    return out
  }

  public async forward(input: TNetInput, inputSize: number): Promise<tf.Tensor4D> {
    return await this.forwardInput(await toNetInput(input, true, true), inputSize)
  }

  public async detect(input: TNetInput, forwardParams: TinyYolov2ForwardParams = {}): Promise<ObjectDetection[]> {

    const { inputSize: _inputSize, scoreThreshold } = getDefaultParams(forwardParams)

    const inputSize = typeof _inputSize === 'string'
      ? INPUT_SIZES[_inputSize]
      : _inputSize

    if (typeof inputSize !== 'number') {
      throw new Error(`TinyYolov2 - unknown inputSize: ${inputSize}, expected number or one of xs | sm | md | lg`)
    }

    const netInput = await toNetInput(input, true)
    const out = await this.forwardInput(netInput, inputSize)
    const out0 = tf.tidy(() => tf.unstack(out)[0].expandDims()) as tf.Tensor4D

    const inputDimensions = {
      width: netInput.getInputWidth(0),
      height: netInput.getInputHeight(0)
    }

    const results = this.extractBoxes(out0, netInput.getReshapedInputDimensions(0), scoreThreshold)
    out.dispose()
    out0.dispose()

    const boxes = results.map(res => res.box)
    const scores = results.map(res => res.score)
    const classNames = results.map(res => this.config.classes[res.classLabel])

    const indices = nonMaxSuppression(
      boxes.map(box => box.rescale(inputSize)),
      scores,
      this.config.iouThreshold,
      true
    )

    const detections = indices.map(idx =>
      new ObjectDetection(
        scores[idx],
        classNames[idx],
        boxes[idx].toRect(),
        inputDimensions
      )
    )

    return detections
  }

  public computeLoss(outTensor: tf.Tensor4D, groundTruth: GroundTruth[], reshapedImgDims: Dimensions) {

    const config = validateTrainConfig(this.config)

    const inputSize = Math.max(reshapedImgDims.width, reshapedImgDims.height)

    if (!inputSize) {
      throw new Error(`computeLoss - invalid inputSize: ${inputSize}`)
    }

    const groundTruthBoxes = assignGroundTruthToAnchors(
      groundTruth,
      this.config.anchors,
      reshapedImgDims
    )

    const groundTruthMask = createGroundTruthMask(groundTruthBoxes, inputSize, this.boxEncodingSize, this.config.anchors.length)
    const { coordMask, scoreMask } = createCoordAndScoreMasks(inputSize, this.boxEncodingSize, this.config.anchors.length)

    const noObjectLossMask = tf.tidy(() => tf.mul(scoreMask, tf.sub(tf.scalar(1), groundTruthMask))) as tf.Tensor4D
    const objectLossMask = tf.tidy(() => tf.mul(scoreMask, groundTruthMask)) as tf.Tensor4D
    const coordLossMask = tf.tidy(() => tf.mul(coordMask, groundTruthMask)) as tf.Tensor4D

    const squaredSumOverMask = (mask: tf.Tensor<tf.Rank>, lossTensor: tf.Tensor4D) =>
      tf.tidy(() => tf.sum(tf.square(tf.mul(mask, lossTensor))))

    const computeLossTerm = (scale: number, mask: tf.Tensor<tf.Rank>, lossTensor: tf.Tensor4D) =>
      tf.tidy(() => tf.mul(tf.scalar(scale), squaredSumOverMask(mask, lossTensor)))

    const noObjectLoss = computeLossTerm(
      config.noObjectScale,
      noObjectLossMask,
      this.computeNoObjectLoss(outTensor)
    )

    const objectLoss = computeLossTerm(
      config.objectScale,
      objectLossMask,
      this.computeObjectLoss(groundTruthBoxes, outTensor, reshapedImgDims)
    )

    const coordLoss = computeLossTerm(
      config.coordScale,
      coordLossMask,
      this.computeCoordLoss(groundTruthBoxes, outTensor, reshapedImgDims)
    )

    const classLoss = this.withClassScores
      ? computeLossTerm(
          config.classScale,
          tf.scalar(1),
          this.computeClassLoss(groundTruthBoxes, outTensor)
        )
      : tf.scalar(0)

    const totalLoss = tf.tidy(() => noObjectLoss.add(objectLoss).add(coordLoss).add(classLoss))

    return {
      noObjectLoss,
      objectLoss,
      coordLoss,
      classLoss,
      totalLoss
    }
  }

  protected loadQuantizedParams(modelUri: string | undefined) {
    if (!modelUri) {
      throw new Error('loadQuantizedParams - please specify the modelUri')
    }

    return loadQuantizedParams(modelUri, this.config.withSeparableConvs)
  }

  protected extractParams(weights: Float32Array) {
    return extractParams(weights, this.config.withSeparableConvs, this.boxEncodingSize)
  }

  private extractBoxes(
    outputTensor: tf.Tensor4D,
    inputBlobDimensions: Dimensions,
    scoreThreshold?: number
  ) {

    const { width, height } = inputBlobDimensions
    const inputSize = Math.max(width, height)
    const correctionFactorX = inputSize / width
    const correctionFactorY = inputSize / height

    const numCells = outputTensor.shape[1]
    const numBoxes = this.config.anchors.length

    const [boxesTensor, scoresTensor, classScoresTensor] = tf.tidy(() => {
      const reshaped = outputTensor.reshape([numCells, numCells, numBoxes, this.boxEncodingSize])

      const boxes = reshaped.slice([0, 0, 0, 0], [numCells, numCells, numBoxes, 4])
      const scores = reshaped.slice([0, 0, 0, 4], [numCells, numCells, numBoxes, 1])
      const classScores = this.withClassScores
        ? tf.softmax(reshaped.slice([0, 0, 0, 5], [numCells, numCells, numBoxes, this.config.classes.length]), 3)
        : tf.scalar(0)
      return [boxes, scores, classScores]
    })

    const results = []

    for (let row = 0; row < numCells; row ++) {
      for (let col = 0; col < numCells; col ++) {
        for (let anchor = 0; anchor < numBoxes; anchor ++) {
          const score = sigmoid(scoresTensor.get(row, col, anchor, 0))
          if (!scoreThreshold || score > scoreThreshold) {
            const ctX = ((col + sigmoid(boxesTensor.get(row, col, anchor, 0))) / numCells) * correctionFactorX
            const ctY = ((row + sigmoid(boxesTensor.get(row, col, anchor, 1))) / numCells) * correctionFactorY
            const width = ((Math.exp(boxesTensor.get(row, col, anchor, 2)) * this.config.anchors[anchor].x) / numCells) * correctionFactorX
            const height = ((Math.exp(boxesTensor.get(row, col, anchor, 3)) * this.config.anchors[anchor].y) / numCells) * correctionFactorY

            const x = (ctX - (width / 2))
            const y = (ctY - (height / 2))

            const pos = { row, col, anchor }
            const { classScore, classLabel } = this.withClassScores
              ? this.extractPredictedClass(classScoresTensor as tf.Tensor4D, pos)
              : { classScore: 1, classLabel: 0 }

            results.push({
              box: new BoundingBox(x, y, x + width, y + height),
              score: score * classScore,
              classLabel,
              ...pos
            })
          }
        }
      }
    }

    boxesTensor.dispose()
    scoresTensor.dispose()

    return results
  }

  private extractPredictedClass(classesTensor: tf.Tensor4D, pos: { row: number, col: number, anchor: number }) {
    const { row, col, anchor } = pos
    return Array(this.config.classes.length).fill(0)
      .map((_, i) => classesTensor.get(row, col, anchor, i))
      .map((classScore, classLabel) => ({
        classScore,
        classLabel
      }))
      .reduce((max, curr) => max.classScore > curr.classScore ? max : curr)
  }

  private computeNoObjectLoss(outTensor: tf.Tensor4D): tf.Tensor4D {
    return tf.tidy(() => tf.sigmoid(outTensor))
  }

  private computeObjectLoss(groundTruthBoxes: GroundTruthWithGridPosition[], outTensor: tf.Tensor4D, reshapedImgDims: Dimensions): tf.Tensor4D {
    return tf.tidy(() => {
      const predBoxes = this.extractBoxes(
        outTensor,
        reshapedImgDims
      )

      const ious = computeIous(
        predBoxes,
        groundTruthBoxes,
        reshapedImgDims
      )

      return tf.sub(ious, tf.sigmoid(outTensor))
    })
  }

  private computeCoordLoss(groundTruthBoxes: GroundTruthWithGridPosition[], outTensor: tf.Tensor4D, reshapedImgDims: Dimensions): tf.Tensor4D {
    return tf.tidy(() => {
      const boxAdjustments = computeBoxAdjustments(
        groundTruthBoxes,
        this.config.anchors,
        reshapedImgDims
      )

      return tf.sub(boxAdjustments, outTensor)
    })
  }

  private computeClassLoss(groundTruthBoxes: GroundTruthWithGridPosition[], outTensor: tf.Tensor4D): tf.Tensor4D {

    const numCells = outTensor.shape[1]
    const numBoxes = this.config.anchors.length

    return tf.tidy(() => {
      const gtClassScores = createOneHotClassScoreMask(groundTruthBoxes, numCells, this.config.classes.length, this.config.anchors.length)
      const reshaped = outTensor.reshape([numCells, numCells, numBoxes, this.boxEncodingSize])
      const classScores = tf.softmax(reshaped.slice([0, 0, 0, 5], [numCells, numCells, numBoxes, this.config.classes.length]), 3)

      return tf.sub(gtClassScores, classScores)
    })
  }
}