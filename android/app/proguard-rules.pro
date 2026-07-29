# qwen3_tts_jni resolves this exact class, its nested DTO constructors, fields,
# callbacks, and native method names. Keep the contract intact if shrinking is
# enabled in a future release build.
-keep class com.qwen.tts.studio.engine.QwenEngine { *; }
-keep class com.qwen.tts.studio.engine.QwenEngine$* { *; }
-keepclasseswithmembernames,includedescriptorclasses class * {
    native <methods>;
}

