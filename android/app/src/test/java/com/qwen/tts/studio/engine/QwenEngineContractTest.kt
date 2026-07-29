package com.qwen.tts.studio.engine

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Test

class QwenEngineContractTest {
    @Test
    fun nativeParamsExposeTheFieldsExpectedByJni() {
        val paramsClass = QwenEngine.NativeParams::class.java

        assertEquals(Int::class.javaPrimitiveType, paramsClass.getDeclaredField("languageId").type)
        assertEquals(String::class.java, paramsClass.getDeclaredField("instruction").type)
        assertEquals(String::class.java, paramsClass.getDeclaredField("speaker").type)
        assertEquals(Int::class.javaPrimitiveType, paramsClass.getDeclaredField("maxAudioTokens").type)
    }

    @Test
    fun nativeResultHasTheConstructorDescriptorExpectedByJni() {
        val constructor = QwenEngine.NativeResult::class.java.declaredConstructors.firstOrNull { candidate ->
            candidate.parameterTypes.contentEquals(
                arrayOf<Class<*>>(
                    FloatArray::class.java,
                    Integer.TYPE,
                    java.lang.Boolean.TYPE,
                    String::class.java,
                    java.lang.Long.TYPE,
                ),
            )
        }

        assertNotNull("JNI expects NativeResult([F, int, boolean, String, long)", constructor)
    }

    @Test
    fun streamingCallbackHasTheMethodDescriptorExpectedByJni() {
        val method = QwenEngine.StreamingCallback::class.java.getDeclaredMethod(
            "onAudioChunk",
            FloatArray::class.java,
            Integer.TYPE,
            java.lang.Long.TYPE,
            java.lang.Long.TYPE,
            Integer.TYPE,
            Integer.TYPE,
            Integer.TYPE,
            Integer.TYPE,
            Integer.TYPE,
            java.lang.Float.TYPE,
        )

        assertEquals(java.lang.Boolean.TYPE, method.returnType)
    }
}
