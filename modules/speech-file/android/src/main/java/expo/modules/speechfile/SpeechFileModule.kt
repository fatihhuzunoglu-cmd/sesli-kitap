package expo.modules.speechfile

import android.net.Uri
import android.os.Bundle
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.speech.tts.Voice
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import java.io.File
import java.io.RandomAccessFile
import java.util.Locale
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

class SynthesizeOptions : Record {
  @Field val voiceId: String? = null
  @Field val language: String? = null
  @Field val pitch: Double? = null
}

class SpeechFileModule : Module() {
  private var tts: TextToSpeech? = null
  private var state = State.IDLE
  private val waiting = mutableListOf<(TextToSpeech?) -> Unit>()
  private val jobs = ConcurrentHashMap<String, Pair<File, Promise>>()

  private enum class State { IDLE, INITIALISING, READY, FAILED }

  override fun definition() = ModuleDefinition {
    Name("SpeechFile")

    Constant("fileExtension") { "wav" }

    AsyncFunction("getVoices") { promise: Promise ->
      withTts { engine ->
        if (engine == null) {
          promise.resolve(emptyList<Map<String, Any>>())
        } else {
          promise.resolve(voicesOf(engine))
        }
      }
    }

    AsyncFunction("synthesize") { text: String, path: String, options: SynthesizeOptions, promise: Promise ->
      withTts { engine ->
        if (engine == null) {
          promise.reject("ERR_TTS_UNAVAILABLE", "Text-to-speech engine is not available", null)
          return@withTts
        }
        synthesize(engine, text, path, options, promise)
      }
    }

    AsyncFunction("cancelPending") {
      tts?.stop()
      val pending = jobs.values.toList()
      jobs.clear()
      pending.forEach { (_, promise) -> promise.resolve(mapOf("durationMs" to 0.0, "written" to false)) }
    }

    OnDestroy {
      tts?.shutdown()
      tts = null
    }
  }

  private fun withTts(block: (TextToSpeech?) -> Unit) {
    synchronized(this) {
      when (state) {
        State.READY -> return block(tts)
        State.FAILED -> return block(null)
        State.INITIALISING -> {
          waiting.add(block)
          return
        }
        State.IDLE -> {
          waiting.add(block)
          state = State.INITIALISING
        }
      }
    }
    val context = appContext.reactContext ?: run {
      flush(State.FAILED)
      return
    }
    tts = TextToSpeech(context) { status ->
      if (status == TextToSpeech.SUCCESS) {
        tts?.setOnUtteranceProgressListener(listener)
        flush(State.READY)
      } else {
        flush(State.FAILED)
      }
    }
  }

  private fun flush(newState: State) {
    val callbacks = synchronized(this) {
      state = newState
      val copy = waiting.toList()
      waiting.clear()
      copy
    }
    val engine = if (newState == State.READY) tts else null
    callbacks.forEach { it(engine) }
  }

  private val listener = object : UtteranceProgressListener() {
    override fun onStart(utteranceId: String) {}

    override fun onDone(utteranceId: String) {
      val (file, promise) = jobs.remove(utteranceId) ?: return
      val duration = wavDurationMs(file)
      promise.resolve(mapOf("durationMs" to duration, "written" to (duration > 0)))
    }

    @Deprecated("Deprecated in Java")
    override fun onError(utteranceId: String) {
      onError(utteranceId, TextToSpeech.ERROR)
    }

    override fun onError(utteranceId: String, errorCode: Int) {
      val (_, promise) = jobs.remove(utteranceId) ?: return
      promise.reject("ERR_SYNTHESIS", "Speech synthesis failed (code $errorCode)", null)
    }

    override fun onStop(utteranceId: String, interrupted: Boolean) {
      val (_, promise) = jobs.remove(utteranceId) ?: return
      promise.resolve(mapOf("durationMs" to 0.0, "written" to false))
    }
  }

  private fun synthesize(engine: TextToSpeech, text: String, path: String, options: SynthesizeOptions, promise: Promise) {
    val file = File(Uri.parse(path).path ?: path)
    file.parentFile?.mkdirs()
    if (file.exists()) file.delete()

    val voice = options.voiceId?.let { id -> engine.voices?.firstOrNull { it.name == id } }
    if (voice != null) {
      engine.voice = voice
    } else {
      options.language?.let { engine.language = Locale.forLanguageTag(it) }
    }
    engine.setPitch((options.pitch ?: 1.0).toFloat().coerceIn(0.5f, 2.0f))
    engine.setSpeechRate(1.0f)

    val id = UUID.randomUUID().toString()
    jobs[id] = file to promise
    val result = engine.synthesizeToFile(text, Bundle(), file, id)
    if (result != TextToSpeech.SUCCESS) {
      jobs.remove(id)
      promise.reject("ERR_SYNTHESIS", "Speech synthesis could not start", null)
    }
  }

  private fun voicesOf(engine: TextToSpeech): List<Map<String, Any>> {
    val voices: Set<Voice> = try {
      engine.voices ?: emptySet()
    } catch (e: Exception) {
      emptySet()
    }
    return voices.map { v ->
      val quality = when {
        v.quality >= Voice.QUALITY_VERY_HIGH -> "premium"
        v.quality >= Voice.QUALITY_HIGH -> "enhanced"
        else -> "default"
      }
      val notInstalled = v.features?.contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED) == true
      mapOf(
        "id" to v.name,
        "name" to v.name,
        "language" to v.locale.toLanguageTag(),
        "quality" to quality,
        "gender" to "unspecified",
        "network" to v.isNetworkConnectionRequired,
        "installed" to !notInstalled,
      )
    }
  }

  // WAV header: channels @22, sample rate @24, bits per sample @34; PCM data follows the 44-byte header.
  private fun wavDurationMs(file: File): Double {
    if (!file.exists() || file.length() <= 44) return 0.0
    return try {
      RandomAccessFile(file, "r").use { raf ->
        val header = ByteArray(44)
        raf.readFully(header)
        fun le16(o: Int) = (header[o].toInt() and 0xff) or ((header[o + 1].toInt() and 0xff) shl 8)
        fun le32(o: Int) = le16(o) or (le16(o + 2) shl 16)
        val channels = le16(22).coerceAtLeast(1)
        val sampleRate = le32(24).coerceAtLeast(1)
        val bits = le16(34).coerceAtLeast(8)
        val bytesPerSecond = sampleRate.toDouble() * channels * bits / 8
        (file.length() - 44) / bytesPerSecond * 1000
      }
    } catch (e: Exception) {
      0.0
    }
  }
}
