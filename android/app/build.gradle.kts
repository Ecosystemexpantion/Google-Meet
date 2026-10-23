plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "io.eem26.cast"
    compileSdk = 35

    defaultConfig {
        applicationId = "io.eem26.cast"
        minSdk = 24
        targetSdk = 35
        versionCode = 10
        versionName = "2.8"
    }

    // A fixed key so new versions install over old ones. It's committed on
    // purpose: this app is side-loaded from the class site, not the Play Store.
    signingConfigs {
        create("site") {
            storeFile = file("../cast.keystore")
            storePassword = "eem26cast"
            keyAlias = "eem26cast"
            keyPassword = "eem26cast"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("site")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("io.getstream:stream-webrtc-android:1.3.10")
}
