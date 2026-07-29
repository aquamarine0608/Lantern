package com.aquamarine0608.lantern.runtime

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import java.nio.ByteBuffer
import java.nio.ByteOrder

class PcmWavTest {
    @Test
    fun writesAStandardsCompliantMonoPcm16HeaderAndClipsSamples() {
        val wav = PcmWav.encodeMonoPcm16(floatArrayOf(-2f, -1f, 0f, 1f, 2f), 24_000)
        val view = ByteBuffer.wrap(wav).order(ByteOrder.LITTLE_ENDIAN)

        assertEquals("RIFF", wav.ascii(0, 4))
        assertEquals(wav.size - 8, view.getInt(4))
        assertEquals("WAVE", wav.ascii(8, 4))
        assertEquals("fmt ", wav.ascii(12, 4))
        assertEquals(16, view.getInt(16))
        assertEquals(1, view.getShort(20).toInt())
        assertEquals(1, view.getShort(22).toInt())
        assertEquals(24_000, view.getInt(24))
        assertEquals(48_000, view.getInt(28))
        assertEquals(2, view.getShort(32).toInt())
        assertEquals(16, view.getShort(34).toInt())
        assertEquals("data", wav.ascii(36, 4))
        assertEquals(10, view.getInt(40))
        assertEquals(Short.MIN_VALUE, view.getShort(44))
        assertEquals(Short.MIN_VALUE, view.getShort(46))
        assertEquals(0, view.getShort(48).toInt())
        assertEquals(Short.MAX_VALUE, view.getShort(50))
        assertEquals(Short.MAX_VALUE, view.getShort(52))
    }

    @Test
    fun linearSpeedResamplingUsesDeterministicInterpolation() {
        assertArrayEquals(
            floatArrayOf(0f, 2f, 4f),
            PcmWav.resampleLinearForSpeed(floatArrayOf(0f, 1f, 2f, 3f, 4f), 2.0),
            0.000_001f,
        )
        assertArrayEquals(
            floatArrayOf(0f, 0.5f, 1f, 0.5f, 0f, 0f),
            PcmWav.resampleLinearForSpeed(floatArrayOf(0f, 1f, 0f), 0.5),
            0.000_001f,
        )
    }

    @Test
    fun rejectsNonFiniteAudio() {
        assertThrows(IllegalArgumentException::class.java) {
            PcmWav.encodeMonoPcm16(floatArrayOf(Float.NaN), 24_000)
        }
        assertThrows(IllegalArgumentException::class.java) {
            PcmWav.resampleLinearForSpeed(floatArrayOf(Float.POSITIVE_INFINITY), 1.0)
        }
    }

    private fun ByteArray.ascii(offset: Int, length: Int): String =
        copyOfRange(offset, offset + length).toString(Charsets.US_ASCII)
}
