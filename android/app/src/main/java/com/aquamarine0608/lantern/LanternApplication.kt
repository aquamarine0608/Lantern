package com.aquamarine0608.lantern

import android.app.Application
import com.aquamarine0608.lantern.model.QwenModelInstaller
import com.aquamarine0608.lantern.runtime.QwenNativeRuntime
import kotlinx.coroutines.sync.Mutex

/**
 * Process owner for the heavyweight Qwen runtime.
 *
 * Activity recreation must never create a second native model context while an old
 * synthesis call is still unwinding. Android releases this owner with the process.
 */
class LanternApplication : Application() {
    val qwenRuntime: QwenNativeRuntime by lazy(LazyThreadSafetyMode.SYNCHRONIZED) {
        QwenNativeRuntime()
    }

    val qwenModelInstaller: QwenModelInstaller by lazy(LazyThreadSafetyMode.SYNCHRONIZED) {
        QwenModelInstaller(applicationContext)
    }

    private val synthesisCoordinator = NativeSynthesisCoordinator()
    internal val qwenMaintenanceMutex = Mutex()

    internal fun openSynthesisSession(): NativeSynthesisSession =
        synthesisCoordinator.openSession()
}
