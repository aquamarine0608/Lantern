package com.aquamarine0608.lantern.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class QwenModelManifestTest {
    @Test
    fun pinnedManifestContainsOnlyTheTwoExactImmutableArtifacts() {
        val manifest = PinnedQwenModelManifest.value

        assertEquals("Serveurperso/Qwen3-TTS-GGUF", manifest.repository)
        assertEquals("968442208ea86f312b6b67ac8ef0c1b551967e35", manifest.revision)
        assertEquals(883_879_808L, manifest.expectedInstalledBytes)
        assertEquals(2, manifest.artifacts.size)
        assertEquals(
            listOf(
                Triple(
                    "qwen-talker-0.6b-base-Q4_K_M.gguf",
                    628_905_056L,
                    "4b468ec7b1f62b90ef4ca316c0aa57deadfd54b2cf9651703ea753cedaf04226",
                ),
                Triple(
                    "qwen-tokenizer-12hz-Q4_K_M.gguf",
                    254_974_752L,
                    "cf3788b4d50aaa665fb6e57c170396aae03a3555fea52d2b5d0cda902d658039",
                ),
            ),
            manifest.artifacts.map { Triple(it.fileName, it.expectedBytes, it.sha256) },
        )
        manifest.artifacts.forEach { artifact ->
            assertEquals(
                "https://huggingface.co/${manifest.repository}/resolve/${manifest.revision}/${artifact.fileName}",
                artifact.downloadUrl,
            )
        }
        assertTrue(manifest.canonicalDigest().matches(Regex("^[0-9a-f]{64}$")))
    }

    @Test
    fun mutableRevisionIsRejected() {
        val pinned = PinnedQwenModelManifest.value
        assertThrows(IllegalArgumentException::class.java) {
            pinned.copy(revision = "main")
        }
    }

    @Test
    fun urlThatDoesNotMatchThePinnedRepositoryPathIsRejected() {
        val pinned = PinnedQwenModelManifest.value
        val changed = pinned.artifacts.first().copy(
            downloadUrl = "https://example.com/${pinned.artifacts.first().fileName}",
        )
        assertThrows(IllegalArgumentException::class.java) {
            pinned.copy(artifacts = listOf(changed) + pinned.artifacts.drop(1))
        }
    }

    @Test
    fun duplicateFileNamesAreRejected() {
        val pinned = PinnedQwenModelManifest.value
        val first = pinned.artifacts.first()
        val duplicate = first.copy(id = "duplicate")
        assertThrows(IllegalArgumentException::class.java) {
            pinned.copy(artifacts = listOf(first, duplicate))
        }
    }
}
