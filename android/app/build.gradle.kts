plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val lanternWebRoot = rootProject.layout.projectDirectory.dir("..")
val lanternWebAssetPaths = listOf(
    "index.html",
    "android-bridge-bootstrap.js",
    "native-tts-adapter.js",
    "manifest.webmanifest",
    "icon-180.png",
    "icon-512.png",
    "vendor/fflate-0.8.3.js",
    "vendor/fflate-LICENSE.txt",
)
val generatedWebAssets = layout.buildDirectory.dir("generated/assets")

val syncLanternWebAssets by tasks.registering(Sync::class) {
    group = "build"
    description = "Stages the pinned Lantern web shell for Android packaging."
    from(lanternWebRoot) {
        include(lanternWebAssetPaths)
        includeEmptyDirs = false
    }
    into(generatedWebAssets.map { it.dir("www") })
    duplicatesStrategy = DuplicatesStrategy.FAIL

    doFirst {
        val missing = lanternWebAssetPaths.filterNot { relativePath ->
            lanternWebRoot.file(relativePath).asFile.isFile
        }
        check(missing.isEmpty()) {
            "Missing required Lantern web assets: ${missing.joinToString()}"
        }
    }
}

android {
    namespace = "com.aquamarine0608.lantern"
    compileSdk = 36
    ndkVersion = "28.2.13676358"

    defaultConfig {
        applicationId = "com.aquamarine0608.lantern"
        minSdk = 31
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"

        ndk {
            abiFilters += "arm64-v8a"
        }

        externalNativeBuild {
            cmake {
                targets += "qwen3_tts_jni"
                arguments += listOf(
                    "-DANDROID_STL=c++_shared",
                    "-DANDROID_SUPPORT_FLEXIBLE_PAGE_SIZES=ON",
                )
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        buildConfig = true
    }

    externalNativeBuild {
        cmake {
            path = file("src/main/cpp/CMakeLists.txt")
            version = "3.22.1"
        }
    }

    packaging {
        jniLibs {
            useLegacyPackaging = false
        }
    }

    sourceSets {
        getByName("main").assets.srcDir(generatedWebAssets)
    }
}

tasks.named("preBuild").configure {
    dependsOn(syncLanternWebAssets)
}

kotlin {
    jvmToolchain(17)
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

dependencies {
    implementation("androidx.activity:activity-ktx:1.13.0")
    implementation("androidx.webkit:webkit:1.16.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.10.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")

    testImplementation("junit:junit:4.13.2")
}
