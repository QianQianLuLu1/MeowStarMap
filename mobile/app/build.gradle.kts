plugins { id("com.android.application") }

val releaseStore = providers.environmentVariable("MOMO_RELEASE_STORE_FILE").orNull
val releasePassword = providers.environmentVariable("MOMO_RELEASE_STORE_PASSWORD").orNull
val releaseAlias = providers.environmentVariable("MOMO_RELEASE_KEY_ALIAS").orElse("momo-camera").get()
val releaseSigningReady = !releaseStore.isNullOrBlank() && !releasePassword.isNullOrBlank()
val storeSubmission = providers.gradleProperty("momoStoreSubmission").orElse("false").get().also { require(it == "true" || it == "false") }
// 喵星图移植版默认关闭 APK 自更新（上游 feed/密钥与本应用包名、签名不匹配）；自建 feed 时以 -PmeowSelfUpdate=true 打开。
val selfUpdate = providers.gradleProperty("meowSelfUpdate").orElse("false").get().also { require(it == "true" || it == "false") }
val supportUrl = providers.gradleProperty("momoSupportUrl")
    .orElse(providers.environmentVariable("MOMO_SUPPORT_URL")).orElse("").get()
    .also { require(it.none(Char::isISOControl)) }

android {
    namespace = "app.nikkisync.mobile"
    compileSdk = 35
    ndkVersion = "28.1.13356709"
    externalNativeBuild {
        cmake { path = file("src/main/cpp/CMakeLists.txt"); version = "3.22.1" }
    }

    defaultConfig {
        applicationId = "com.qianlu.meowstarmap"
        minSdk = 30
        targetSdk = 35
        versionCode = 67
        versionName = "1.0.41"
        ndk { abiFilters += listOf("arm64-v8a", "armeabi-v7a", "x86_64", "x86") }
        externalNativeBuild { cmake { targets += "momo_jpeg" } }
        buildConfigField("boolean", "STORE_SUBMISSION", storeSubmission)
        buildConfigField("boolean", "SELF_UPDATE", selfUpdate)
        buildConfigField("String", "SUPPORT_URL", "\"${supportUrl.replace("\\", "\\\\").replace("\"", "\\\"")}\"")
        buildConfigField("String", "APP_FILING_NUMBER", "\"${providers.gradleProperty("momoFilingNumber").orElse("").get().replace("\\", "\\\\").replace("\"", "\\\"")}\"")
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    signingConfigs {
        if (releaseSigningReady) create("officialRelease") {
            storeFile = file(releaseStore!!)
            storePassword = releasePassword
            keyAlias = releaseAlias
            keyPassword = releasePassword
        }
    }
    buildTypes {
        release {
            isMinifyEnabled = false
            isDebuggable = false
            if (releaseSigningReady) signingConfig = signingConfigs.getByName("officialRelease")
        }
    }

    buildFeatures { buildConfig = true }
    if (storeSubmission == "true") {
        sourceSets.getByName("debug").manifest.srcFile("src/store/AndroidManifest.xml")
        sourceSets.getByName("release").manifest.srcFile("src/store/AndroidManifest.xml")
    }
    // Java 9 OSGi descriptors in transitive jars are unused on Android; retain their license files.
    packaging.resources.excludes.add("META-INF/versions/9/OSGI-INF/MANIFEST.MF")
    testOptions { unitTests.isIncludeAndroidResources = true }
    compileOptions {
        isCoreLibraryDesugaringEnabled = true
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

val legalAssets = layout.buildDirectory.dir("generated/legalAssets")
val bundleLegalDocuments = tasks.register<Copy>("bundleLegalDocuments") {
    from(rootProject.projectDir.resolve("legal")) {
        include("PRIVACY_POLICY.md", "USER_AGREEMENT.md", "PERMISSIONS_DATA.md", "SDK_SERVICES.md")
        into("legal")
    }
    from(rootProject.projectDir.resolve("signing/update-public-key.pem")) {
        into("updates")
    }
    into(legalAssets)
}
android.sourceSets.getByName("main").assets.srcDir(legalAssets)
tasks.named("preBuild") { dependsOn(bundleLegalDocuments) }
tasks.configureEach {
    if (name == "preReleaseBuild") doFirst {
        check(releaseSigningReady && file(releaseStore!!).isFile) {
            "Official signing is required. Use scripts/build-official-android.ps1; an unsigned release must not be distributed."
        }
    }
}

dependencies {
    // Backport Java 11+ APIs (including String.isBlank and Stream.toList) on Android 11/12.
    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.1.5")
    implementation("androidx.exifinterface:exifinterface:1.4.2")
    // Lightweight Ed25519 only; do not register a global BC provider or rely on OEM JCA order.
    implementation("org.bouncycastle:bcprov-jdk18on:1.86")
    implementation("androidx.recyclerview:recyclerview:1.4.0")
    // 1.13.0 requires SDK 36 / AGP 8.9.1; this branch intentionally builds on SDK 35 / AGP 8.7.3.
    implementation("androidx.activity:activity:1.10.1")
    implementation("com.google.zxing:core:3.5.3")
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
    // Pin together: quarter-turn optimization and portrait encoding were reviewed at this tag.
    implementation("androidx.media3:media3-transformer:1.8.0")
    implementation("androidx.media3:media3-effect:1.8.0")
    implementation("androidx.media3:media3-exoplayer:1.8.0")
    implementation("androidx.media3:media3-ui:1.8.0")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
    testImplementation("org.robolectric:robolectric:4.17")
    androidTestImplementation("androidx.test:runner:1.6.2")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
}

// Keep the user-facing APK beside the existing desktop bundle after an Android build.
tasks.register<Copy>("stageDebugApk") {
    dependsOn("assembleDebug")
    from(layout.buildDirectory.file("outputs/apk/debug/app-debug.apk")) {
        rename { "MeowStarMap-Android.apk" }
    }
    into(rootProject.projectDir.resolve("../release"))
}
