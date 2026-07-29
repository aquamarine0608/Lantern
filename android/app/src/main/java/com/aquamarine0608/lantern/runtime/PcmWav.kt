package com.aquamarine0608.lantern.runtime

import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.ceil
import kotlin.math.roundToInt

/** Pure Kotlin PCM helpers kept independent of Android so their byte output is unit-testable. */
object PcmWav {
    const val HEADER_BYTES = 44

    fun encodeMonoPcm16(samples: FloatArray, sampleRateHz: Int): ByteArray {
        require(samples.isNotEmpty()) { "Cannot encode an empty waveform" }
        require(sampleRateHz in 8_000..192_000) { "Unsupported sample rate: $sampleRateHz" }
        require(samples.all(Float::isFinite)) { "Waveform contains a non-finite sample" }

        val dataBytes = Math.multiplyExact(samples.size, Short.SIZE_BYTES)
        val output = ByteBuffer.allocate(Math.addExact(HEADER_BYTES, dataBytes))
            .order(ByteOrder.LITTLE_ENDIAN)

        output.putAscii("RIFF")
        output.putInt(36 + dataBytes)
        output.putAscii("WAVE")
        output.putAscii("fmt ")
        output.putInt(16)
        output.putShort(1) // PCM
        output.putShort(1) // mono
        output.putInt(sampleRateHz)
        output.putInt(Math.multiplyExact(sampleRateHz, Short.SIZE_BYTES))
        output.putShort(Short.SIZE_BYTES.toShort())
        output.putShort(16)
        output.putAscii("data")
        output.putInt(dataBytes)

        samples.forEach { sample ->
            val clipped = sample.coerceIn(-1f, 1f)
            val quantized = if (clipped < 0f) {
                (clipped * 32_768f).roundToInt()
            } else {
                (clipped * 32_767f).roundToInt()
            }
            output.putShort(quantized.coerceIn(Short.MIN_VALUE.toInt(), Short.MAX_VALUE.toInt()).toShort())
        }
        return output.array()
    }

    /**
     * Linear time resampling used only when the caller explicitly asks for a speed change.
     * This changes pitch as well as duration; production-quality pitch preservation belongs
     * in the playback layer or native runtime, not in this small fallback.
     */
    fun resampleLinearForSpeed(samples: FloatArray, speed: Double): FloatArray {
        require(samples.isNotEmpty()) { "Cannot resample an empty waveform" }
        require(samples.all(Float::isFinite)) { "Waveform contains a non-finite sample" }
        require(speed.isFinite() && speed in 0.25..4.0) { "Speed must be between 0.25 and 4.0" }
        if (speed == 1.0) return samples.copyOf()

        val outputSizeDouble = ceil(samples.size.toDouble() / speed)
        require(outputSizeDouble <= Int.MAX_VALUE) { "Resampled waveform is too large" }
        val output = FloatArray(outputSizeDouble.toInt().coerceAtLeast(1))
        for (index in output.indices) {
            val sourcePosition = index * speed
            val left = sourcePosition.toInt().coerceAtMost(samples.lastIndex)
            val right = (left + 1).coerceAtMost(samples.lastIndex)
            val fraction = (sourcePosition - left).coerceIn(0.0, 1.0).toFloat()
            output[index] = samples[left] + (samples[right] - samples[left]) * fraction
        }
        return output
    }

    private fun ByteBuffer.putAscii(value: String) {
        require(value.length == 4)
        value.forEach { character -> put(character.code.toByte()) }
    }
}
