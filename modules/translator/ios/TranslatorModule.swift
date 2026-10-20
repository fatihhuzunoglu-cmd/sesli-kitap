import ExpoModulesCore
import NaturalLanguage
import SwiftUI
import UIKit
#if canImport(Translation)
import Translation
#endif

public class TranslatorModule: Module {
  public func definition() -> ModuleDefinition {
    Name("Translator")

    Function("isSupported") { () -> Bool in
      if #available(iOS 18.0, *) { return true }
      return false
    }

    AsyncFunction("identifyLanguage") { (text: String) -> String in
      let recognizer = NLLanguageRecognizer()
      recognizer.processString(text)
      return recognizer.dominantLanguage?.rawValue ?? "und"
    }

    AsyncFunction("prepare") { (source: String, target: String, promise: Promise) in
      TranslatorModule.run(source: source, target: target, texts: nil, promise: promise)
    }

    AsyncFunction("translate") { (texts: [String], source: String, target: String, promise: Promise) in
      TranslatorModule.run(source: source, target: target, texts: texts, promise: promise)
    }
  }

  static func run(source: String, target: String, texts: [String]?, promise: Promise) {
    #if canImport(Translation)
    if #available(iOS 18.0, *) {
      DispatchQueue.main.async {
        TranslationBridge.shared.enqueue(
          TranslationJob(source: source, target: target, texts: texts) { result in
            switch result {
            case .success(let out): promise.resolve(out)
            case .failure(let error): promise.reject("ERR_TRANSLATE", describe(error))
            }
          }
        )
      }
      return
    }
    #endif
    promise.reject("ERR_UNSUPPORTED", "Çeviri için iOS 18 veya daha yenisi gerekir.")
  }

  // Translation framework errors are already localized to the device language.
  static func describe(_ error: Error) -> String {
    if error is CancellationError {
      return "Dil paketi indirilmedi. Çeviri için dil paketinin indirilmesini onaylayın."
    }
    return error.localizedDescription
  }
}

#if canImport(Translation)
@available(iOS 18.0, *)
struct TranslationJob {
  let source: String
  let target: String
  // nil only prepares (downloads) the languages.
  let texts: [String]?
  let done: (Result<[String], Error>) -> Void

  var pair: (Locale.Language, Locale.Language) {
    (Locale.Language(identifier: source), Locale.Language(identifier: target))
  }
}

// TranslationSession is only handed out to a SwiftUI view, so an invisible view hosted in the app's window
// receives sessions and works through the queued jobs. A new configuration (or invalidating it) starts a new session.
@available(iOS 18.0, *)
@MainActor
final class TranslationBridge: ObservableObject {
  static let shared = TranslationBridge()

  @Published var configuration: TranslationSession.Configuration?
  private var jobs: [TranslationJob] = []
  private var busy = false
  private var host: UIHostingController<TranslationHostView>?

  func enqueue(_ job: TranslationJob) {
    jobs.append(job)
    guard attachIfNeeded() else { return }
    // A running session picks the job up itself, or switches languages when it is done.
    if !busy { start(job) }
  }

  func process(_ session: TranslationSession) async {
    guard let config = configuration else { return }
    busy = true
    while let job = jobs.first, job.pair.0 == config.source, job.pair.1 == config.target {
      jobs.removeFirst()
      do {
        guard let texts = job.texts else {
          try await session.prepareTranslation()
          job.done(.success([]))
          continue
        }
        let requests = texts.enumerated().map { TranslationSession.Request(sourceText: $0.element, clientIdentifier: String($0.offset)) }
        var out = texts
        for response in try await session.translations(from: requests) {
          if let id = response.clientIdentifier, let i = Int(id), i < out.count { out[i] = response.targetText }
        }
        job.done(.success(out))
      } catch {
        job.done(.failure(error))
      }
    }
    busy = false
    if let next = jobs.first { start(next) }
  }

  private func start(_ job: TranslationJob) {
    let (source, target) = job.pair
    if configuration?.source == source, configuration?.target == target {
      configuration?.invalidate()
    } else {
      configuration = TranslationSession.Configuration(source: source, target: target)
    }
  }

  private func attachIfNeeded() -> Bool {
    if let host, host.view.window != nil { return true }
    guard let root = Self.rootViewController() else {
      let pending = jobs
      jobs.removeAll()
      let error = NSError(domain: "Translator", code: 1, userInfo: [NSLocalizedDescriptionKey: "Çeviri başlatılamadı."])
      pending.forEach { $0.done(.failure(error)) }
      return false
    }
    host?.view.removeFromSuperview()
    host?.removeFromParent()
    let controller = UIHostingController(rootView: TranslationHostView(bridge: self))
    controller.view.backgroundColor = .clear
    controller.view.isUserInteractionEnabled = false
    controller.view.frame = CGRect(x: 0, y: 0, width: 1, height: 1)
    root.addChild(controller)
    root.view.addSubview(controller.view)
    controller.didMove(toParent: root)
    host = controller
    return true
  }

  private static func rootViewController() -> UIViewController? {
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    let window = scenes.flatMap { $0.windows }.first { $0.isKeyWindow } ?? scenes.first?.windows.first
    return window?.rootViewController
  }
}

@available(iOS 18.0, *)
struct TranslationHostView: View {
  @ObservedObject var bridge: TranslationBridge

  var body: some View {
    Color.clear
      .frame(width: 1, height: 1)
      .translationTask(bridge.configuration) { session in
        await bridge.process(session)
      }
  }
}
#endif
