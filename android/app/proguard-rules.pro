# Release builds are shrunk and obfuscated with R8. These rules keep what is
# reached by reflection or from native code.

-keepattributes *Annotation*, InnerClasses, Signature, Exceptions, EnclosingMethod, RuntimeVisibleAnnotations
-renamesourcefileattribute SourceFile
-keepattributes SourceFile, LineNumberTable

# --- kotlinx.serialization: every @Serializable model in the app --------------
-dontnote kotlinx.serialization.**
-keepclassmembers class kotlinx.serialization.json.** { *** Companion; }
-keepclasseswithmembers class kotlinx.serialization.json.** { kotlinx.serialization.KSerializer serializer(...); }
-keep,includedescriptorclasses class com.videocall.mobile.**$$serializer { *; }
-keepclassmembers class com.videocall.mobile.** { *** Companion; }
-keepclasseswithmembers class com.videocall.mobile.** { kotlinx.serialization.KSerializer serializer(...); }

# --- WebRTC: called back from native code by name -----------------------------
-keep class org.webrtc.** { *; }
-keep class livekit.org.webrtc.** { *; }
-dontwarn org.webrtc.**
-dontwarn livekit.org.webrtc.**

# --- OkHttp / Okio: optional TLS providers that may be absent ----------------
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**
-dontwarn okhttp3.internal.platform.**

# --- androidx.security.crypto (Tink) keeps protobuf fields by reflection -----
-keepclassmembers class * extends com.google.crypto.tink.shaded.protobuf.GeneratedMessageLite {
    <fields>;
}
-dontwarn com.google.errorprone.annotations.**
-dontwarn javax.annotation.**
-dontwarn com.google.crypto.tink.**
