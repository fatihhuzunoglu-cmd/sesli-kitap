package expo.modules.translator

import com.google.mlkit.nl.languageid.LanguageIdentification
import com.google.mlkit.nl.translate.TranslateLanguage
import com.google.mlkit.nl.translate.Translation
import com.google.mlkit.nl.translate.Translator
import com.google.mlkit.nl.translate.TranslatorOptions
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// ML Kit on-device translation. Each language model (~30 MB) is downloaded once, then everything works offline.
class TranslatorModule : Module() {
  private val translators = mutableMapOf<String, Translator>()
  private val identifier by lazy { LanguageIdentification.getClient() }

  override fun definition() = ModuleDefinition {
    Name("Translator")

    Function("isSupported") { true }

    AsyncFunction("identifyLanguage") { text: String, promise: Promise ->
      identifier.identifyLanguage(text)
        .addOnSuccessListener { promise.resolve(it) }
        .addOnFailureListener { promise.resolve("und") }
    }

    AsyncFunction("prepare") { source: String, target: String, promise: Promise ->
      val translator = translatorFor(source, target, promise) ?: return@AsyncFunction
      translator.downloadModelIfNeeded()
        .addOnSuccessListener { promise.resolve(null) }
        .addOnFailureListener { promise.reject("ERR_DOWNLOAD", DOWNLOAD_FAILED, it) }
    }

    AsyncFunction("translate") { texts: List<String>, source: String, target: String, promise: Promise ->
      val translator = translatorFor(source, target, promise) ?: return@AsyncFunction
      translator.downloadModelIfNeeded()
        .addOnSuccessListener { translateAll(translator, texts, promise) }
        .addOnFailureListener { promise.reject("ERR_DOWNLOAD", DOWNLOAD_FAILED, it) }
    }

    OnDestroy {
      synchronized(translators) {
        translators.values.forEach { it.close() }
        translators.clear()
      }
    }
  }

  private fun translatorFor(source: String, target: String, promise: Promise): Translator? {
    val from = TranslateLanguage.fromLanguageTag(source)
    val to = TranslateLanguage.fromLanguageTag(target)
    if (from == null || to == null) {
      promise.reject("ERR_UNSUPPORTED", "Bu dil çifti için çeviri desteklenmiyor.", null)
      return null
    }
    return synchronized(translators) {
      translators.getOrPut("$from>$to") {
        Translation.getClient(TranslatorOptions.Builder().setSourceLanguage(from).setTargetLanguage(to).build())
      }
    }
  }

  // One text at a time keeps the order and lets a failure stop the batch.
  private fun translateAll(translator: Translator, texts: List<String>, promise: Promise) {
    val out = ArrayList<String>(texts.size)
    fun step(i: Int) {
      if (i == texts.size) {
        promise.resolve(out)
        return
      }
      if (texts[i].isBlank()) {
        out.add(texts[i])
        step(i + 1)
        return
      }
      translator.translate(texts[i])
        .addOnSuccessListener {
          out.add(it)
          step(i + 1)
        }
        .addOnFailureListener { promise.reject("ERR_TRANSLATE", it.message ?: "Çeviri yapılamadı.", it) }
    }
    step(0)
  }

  companion object {
    private const val DOWNLOAD_FAILED = "Çeviri dil paketi indirilemedi. İnternete bağlanıp tekrar deneyin."
  }
}
