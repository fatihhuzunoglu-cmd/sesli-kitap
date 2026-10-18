import AVFoundation
import ExpoModulesCore

struct SynthesizeOptions: Record {
  @Field var voiceId: String? = nil
  @Field var language: String? = nil
  @Field var pitch: Double? = nil
}

private struct Job {
  let id = UUID()
  let text: String
  let url: URL
  let options: SynthesizeOptions
  let promise: Promise
}

// Renders AVSpeechSynthesizer output into audio files, one job at a time (write() is not re-entrant).
// Every callback carries its job id so late buffers or timers from an earlier job can never touch the next one.
private final class SpeechWriter: NSObject, AVSpeechSynthesizerDelegate {
  private let synthesizer = AVSpeechSynthesizer()
  private let lock = NSLock()
  private var queue: [Job] = []
  private var current: Job?
  private var file: AVAudioFile?
  private var frames: AVAudioFramePosition = 0
  private var sampleRate: Double = 0
  private var watchdog: DispatchWorkItem?

  override init() {
    super.init()
    synthesizer.delegate = self
  }

  func enqueue(_ job: Job) {
    lock.lock()
    queue.append(job)
    lock.unlock()
    DispatchQueue.main.async { self.pump() }
  }

  func cancelAll() {
    lock.lock()
    let dropped = queue
    queue.removeAll()
    lock.unlock()
    dropped.forEach { $0.promise.resolve(["durationMs": 0, "written": false]) }
  }

  private func pump() {
    lock.lock()
    guard current == nil, !queue.isEmpty else {
      lock.unlock()
      return
    }
    let job = queue.removeFirst()
    current = job
    file = nil
    frames = 0
    sampleRate = 0
    lock.unlock()

    let utterance = AVSpeechUtterance(string: job.text)
    if let id = job.options.voiceId, let voice = AVSpeechSynthesisVoice(identifier: id) {
      utterance.voice = voice
    } else if let language = job.options.language {
      utterance.voice = AVSpeechSynthesisVoice(language: language)
    }
    utterance.rate = AVSpeechUtteranceDefaultSpeechRate
    utterance.pitchMultiplier = Float(min(max(job.options.pitch ?? 1.0, 0.5), 2.0))
    utterance.prefersAssistiveTechnologySettings = false

    try? FileManager.default.createDirectory(at: job.url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try? FileManager.default.removeItem(at: job.url)

    let id = job.id
    armWatchdog(for: id, seconds: 20)
    synthesizer.write(utterance) { [weak self] buffer in
      self?.handle(buffer, job: id)
    }
  }

  private func handle(_ buffer: AVAudioBuffer, job id: UUID) {
    guard let pcm = buffer as? AVAudioPCMBuffer else { return }
    if pcm.frameLength == 0 {
      complete(job: id, error: nil)
      return
    }
    var failure: Error?
    lock.lock()
    if let job = current, job.id == id {
      do {
        if file == nil {
          file = try AVAudioFile(
            forWriting: job.url,
            settings: pcm.format.settings,
            commonFormat: pcm.format.commonFormat,
            interleaved: pcm.format.isInterleaved
          )
          sampleRate = pcm.format.sampleRate
        }
        try file?.write(from: pcm)
        frames += AVAudioFramePosition(pcm.frameLength)
      } catch {
        failure = error
      }
    }
    lock.unlock()
    if let failure {
      complete(job: id, error: failure)
    } else {
      armWatchdog(for: id, seconds: 10)
    }
  }

  private func armWatchdog(for id: UUID, seconds: Double) {
    DispatchQueue.main.async {
      self.watchdog?.cancel()
      let item = DispatchWorkItem { [weak self] in
        guard let self, self.isCurrent(id) else { return }
        self.synthesizer.stopSpeaking(at: .immediate)
        self.complete(job: id, error: nil)
      }
      self.watchdog = item
      DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: item)
    }
  }

  private func isCurrent(_ id: UUID) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return current?.id == id
  }

  // The last buffer normally has zero frames; didFinish covers systems that skip it.
  func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
    lock.lock()
    let id = current?.id
    lock.unlock()
    guard let id else { return }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { self.complete(job: id, error: nil) }
  }

  private func complete(job id: UUID, error: Error?) {
    lock.lock()
    guard let job = current, job.id == id else {
      lock.unlock()
      return
    }
    let written = frames > 0
    let durationMs = sampleRate > 0 ? Double(frames) / sampleRate * 1000 : 0
    file = nil
    current = nil
    lock.unlock()

    DispatchQueue.main.async { self.watchdog?.cancel() }
    if let error {
      job.promise.reject("ERR_SYNTHESIS", error.localizedDescription)
    } else {
      job.promise.resolve(["durationMs": durationMs, "written": written])
    }
    DispatchQueue.main.async { self.pump() }
  }
}

public class SpeechFileModule: Module {
  private lazy var writer = SpeechWriter()

  public func definition() -> ModuleDefinition {
    Name("SpeechFile")

    Constant("fileExtension") { "caf" }

    AsyncFunction("getVoices") { () -> [[String: Any]] in
      AVSpeechSynthesisVoice.speechVoices().compactMap { voice in
        if #available(iOS 17.0, *), voice.voiceTraits.contains(.isNoveltyVoice) {
          return nil
        }
        let quality: String
        switch voice.quality {
        case .premium: quality = "premium"
        case .enhanced: quality = "enhanced"
        default: quality = "default"
        }
        let gender: String
        switch voice.gender {
        case .male: gender = "male"
        case .female: gender = "female"
        default: gender = "unspecified"
        }
        return [
          "id": voice.identifier,
          "name": voice.name,
          "language": voice.language,
          "quality": quality,
          "gender": gender,
          "network": false,
          "installed": true,
        ]
      }
    }

    AsyncFunction("synthesize") { (text: String, path: String, options: SynthesizeOptions, promise: Promise) in
      let url = path.hasPrefix("file://") ? URL(string: path)! : URL(fileURLWithPath: path)
      self.writer.enqueue(Job(text: text, url: url, options: options, promise: promise))
    }

    AsyncFunction("cancelPending") {
      self.writer.cancelAll()
    }
  }
}
