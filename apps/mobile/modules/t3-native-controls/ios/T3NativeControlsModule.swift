import AVFoundation
import ExpoModulesCore
import Security
import UIKit

@objc(T3SpeechSynthesizerDelegate)
final class T3SpeechSynthesizerDelegate: NSObject, AVSpeechSynthesizerDelegate {
  private let onFinish: () -> Void

  init(onFinish: @escaping () -> Void) {
    self.onFinish = onFinish
    super.init()
  }

  func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
    try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
    onFinish()
  }

  func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
    try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
    onFinish()
  }
}

public final class T3NativeSpeechSynthesizer {
  public static let shared = T3NativeSpeechSynthesizer()
  private let synthesizer = AVSpeechSynthesizer()
  private var activeDelegate: T3SpeechSynthesizerDelegate?

  private init() {}

  public func speak(
    text: String,
    language: String? = nil,
    pitch: Float? = nil,
    rate: Float? = nil,
    voiceIdentifier: String? = nil,
    completion: @escaping () -> Void
  ) {
    if synthesizer.isSpeaking {
      synthesizer.stopSpeaking(at: .immediate)
    }

    let utterance = AVSpeechUtterance(string: text)

    if let voiceIdentifier = voiceIdentifier,
       let voice = AVSpeechSynthesisVoice(identifier: voiceIdentifier) {
      utterance.voice = voice
    } else if let language = language,
              let voice = AVSpeechSynthesisVoice(language: language) {
      utterance.voice = voice
    } else {
      utterance.voice = AVSpeechSynthesisVoice(language: AVSpeechSynthesisVoice.currentLanguageCode())
    }

    if let pitch = pitch {
      utterance.pitchMultiplier = max(0.5, min(2.0, pitch))
    }

    if let rate = rate {
      utterance.rate = max(AVSpeechUtteranceMinimumSpeechRate, min(AVSpeechUtteranceMaximumSpeechRate, rate * AVSpeechUtteranceDefaultSpeechRate))
    }

    let delegate = T3SpeechSynthesizerDelegate { [weak self] in
      self?.activeDelegate = nil
      completion()
    }
    self.activeDelegate = delegate
    synthesizer.delegate = delegate

    do {
      let audioSession = AVAudioSession.sharedInstance()
      try audioSession.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
      try audioSession.setActive(true, options: .notifyOthersOnDeactivation)
    } catch {
      NSLog("[T3NativeSpeechSynthesizer] Audio session activation error: \(error)")
    }

    synthesizer.speak(utterance)
  }

  public func stop() {
    if synthesizer.isSpeaking {
      synthesizer.stopSpeaking(at: .immediate)
    }
    try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
    activeDelegate = nil
  }

  public func pause() {
    if synthesizer.isSpeaking {
      synthesizer.pauseSpeaking(at: .immediate)
    }
  }

  public func resume() {
    if synthesizer.isPaused {
      synthesizer.continueSpeaking()
    }
  }

  public func isSpeaking() -> Bool {
    return synthesizer.isSpeaking
  }
}

// Expo Modules 2.0: plain members marked @JS are bound by the macro, while the
// views and main-queue presenters stay in definition(). Both are merged.
@ExpoModule("T3NativeControls")
public final class T3NativeControlsModule: Module {
  private let presentationSources = T3PresentationSources()
  private var videoPresentation: T3NativeVideoPresentation?
  private var filePresentation: T3NativeFilePresentation?

  public func definition() -> ModuleDefinition {
    Constants {
      if #available(iOS 26.0, *) {
        return [
          "supportsWorkspaceColumns": NSClassFromString("RNSSplitHostComponentView") != nil,
        ]
      }
      return ["supportsWorkspaceColumns": false]
    }
    View(T3LayoutMetricsView.self) {
      ViewName("LayoutMetrics")
      Events("onMetricsChange")
    }

    AsyncFunction("presentVideo") { (url: URL, title: String, sourceIdentifier: String, identifier: String, promise: Promise) in
      try self.presentVideo(
        url: url,
        title: title,
        sourceIdentifier: sourceIdentifier,
        identifier: identifier,
        promise: promise
      )
    }.runOnQueue(.main)

    AsyncFunction("presentFile") { (url: URL, title: String, sourceIdentifier: String, identifier: String, promise: Promise) in
      try self.presentFile(url: url, title: title, sourceIdentifier: sourceIdentifier,
                           identifier: identifier, promise: promise)
    }.runOnQueue(.main)

    AsyncFunction("speakText") { (text: String, options: [String: Any]?, promise: Promise) in
      let language = options?["language"] as? String
      let pitch = (options?["pitch"] as? NSNumber)?.floatValue
      let rate = (options?["rate"] as? NSNumber)?.floatValue
      let voice = options?["voice"] as? String

      T3NativeSpeechSynthesizer.shared.speak(
        text: text,
        language: language,
        pitch: pitch,
        rate: rate,
        voiceIdentifier: voice
      ) {
        promise.resolve(nil)
      }
    }.runOnQueue(.main)

    AsyncFunction("stopSpeaking") { (promise: Promise) in
      T3NativeSpeechSynthesizer.shared.stop()
      promise.resolve(nil)
    }.runOnQueue(.main)

    AsyncFunction("pauseSpeaking") { (promise: Promise) in
      T3NativeSpeechSynthesizer.shared.pause()
      promise.resolve(nil)
    }.runOnQueue(.main)

    AsyncFunction("resumeSpeaking") { (promise: Promise) in
      T3NativeSpeechSynthesizer.shared.resume()
      promise.resolve(nil)
    }.runOnQueue(.main)

    AsyncFunction("deactivateAudioSession") { (promise: Promise) in
      do {
        try AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
        promise.resolve(true)
      } catch {
        promise.resolve(false)
      }
    }

    Function("isSpeaking") { () -> Bool in
      return T3NativeSpeechSynthesizer.shared.isSpeaking()
    }

    OnDestroy {
      let presentation = self.videoPresentation
      let file = self.filePresentation
      DispatchQueue.main.async {
        presentation?.dismiss()
        file?.dismiss()
        T3NativeSpeechSynthesizer.shared.stop()
      }
    }

    View(T3PresentationSourceView.self) {
      ViewName("PresentationSource")
      Prop("identifier") { (view: T3PresentationSourceView, identifier: String) in
        view.sources = self.presentationSources
        view.identifier = identifier
      }
    }

    View(T3FrostedCutoutView.self) {
      ViewName("FrostedCutout")
      Prop("cutoutTop") { (view: T3FrostedCutoutView, value: Double) in view.cutoutTop = CGFloat(value) }
      Prop("cutoutWidth") { (view: T3FrostedCutoutView, value: Double) in view.cutoutWidth = CGFloat(value) }
      Prop("cutoutHeight") { (view: T3FrostedCutoutView, value: Double) in view.cutoutHeight = CGFloat(value) }
      Prop("cutoutRadius") { (view: T3FrostedCutoutView, value: Double) in view.cutoutRadius = CGFloat(value) }
      Prop("appearance") { (view: T3FrostedCutoutView, value: String) in view.appearance = value }
    }

    View(T3ContextSheetSizeView.self) {
      ViewName("ContextSheetSize")
      Prop("contentHeight") { (view: T3ContextSheetSizeView, height: Double) in
        view.contentHeight = CGFloat(height)
      }
    }

    AsyncFunction("shareFileFromSource") { (url: URL, title: String, identifier: String, promise: Promise) in
      try self.shareFile(url: url, title: title, sourceIdentifier: identifier, promise: promise)
    }.runOnQueue(.main)
  }

  // UIKit presenters are main-actor isolated rather than run on the JS thread
  // the macro would otherwise pick.
  @JS
  @MainActor
  func dismissVideo(identifier: String) async {
    dismissVideoPresentation(identifier: identifier)
  }

  @JS
  @MainActor
  func dismissFile(identifier: String) async {
    dismissFilePresentation(identifier: identifier)
  }

  // Rotates the interface without Simulator menu UI scripting, which CI
  // runners cannot perform (osascript is denied Accessibility access there).
  @JS
  @MainActor
  func applyShowcaseOrientation(orientation: String) async {
    let mask: UIInterfaceOrientationMask = orientation == "landscape" ? .landscapeRight : .portrait
    for case let windowScene as UIWindowScene in UIApplication.shared.connectedScenes {
      windowScene.requestGeometryUpdate(.iOS(interfaceOrientations: mask)) { error in
        NSLog("T3NativeControls applyShowcaseOrientation(\(orientation)) failed: \(error)")
      }
      for window in windowScene.windows {
        window.rootViewController?.setNeedsUpdateOfSupportedInterfaceOrientations()
      }
    }
  }

  // The geometry request above can fail transiently (for example before the
  // scene is foreground-active), so callers poll this until it settles.
  // Screen bounds — not the scene's interface orientation — decide the
  // answer because they match the captured framebuffer: with iPadOS
  // windowing active, a floating landscape window still reports a portrait
  // screen, and screenshots would come out portrait.
  @JS
  @MainActor
  func getInterfaceOrientation() async -> String {
    guard
      let windowScene = UIApplication.shared.connectedScenes
        .compactMap({ $0 as? UIWindowScene })
        .first
    else {
      return "unknown"
    }
    let bounds = windowScene.screen.coordinateSpace.bounds
    return bounds.width > bounds.height ? "landscape" : "portrait"
  }

  private func launchArgument(_ flag: String) -> String? {
    let arguments = ProcessInfo.processInfo.arguments
    guard
      let flagIndex = arguments.firstIndex(of: flag),
      arguments.indices.contains(flagIndex + 1)
    else {
      return nil
    }
    return arguments[flagIndex + 1]
  }

  @JS
  func getShowcasePairingUrl() -> String? {
    launchArgument("--showcasePairingUrl")
  }

  @JS
  func getShowcaseScene() -> String? {
    let scenePath = NSHomeDirectory() + "/Library/Caches/T3ShowcaseScene"
    if let storedScene = try? String(contentsOfFile: scenePath, encoding: .utf8)
      .trimmingCharacters(in: .whitespacesAndNewlines), !storedScene.isEmpty {
      return storedScene
    }
    return launchArgument("--showcaseScene")
  }

  // The palette is fixed for the whole capture, so it only ever arrives as a
  // launch argument — unlike the scene, which the runner rewrites in place.
  @JS
  func getShowcaseTheme() -> String? {
    launchArgument("--showcaseTheme")
  }

  @JS
  func getShowcaseOrientation() -> String? {
    launchArgument("--showcaseOrientation")
  }

  @JS
  func prepareShowcaseCapture() {
    for itemClass in [kSecClassGenericPassword, kSecClassInternetPassword] {
      SecItemDelete([kSecClass as String: itemClass] as CFDictionary)
    }
  }

  @JS(.concurrent)
  func markShowcaseReady(scene: String) async {
    let readyPath = NSHomeDirectory() + "/Library/Caches/T3ShowcaseReadyScene"
    try? scene.write(toFile: readyPath, atomically: true, encoding: .utf8)
  }

  private func presentVideo(url: URL, title: String, sourceIdentifier: String, identifier: String, promise: Promise) throws {
    let isPlayableURL = url.isFileURL
      ? FileManager.default.isReadableFile(atPath: url.path)
      : (["https", "http"].contains(url.scheme?.lowercased() ?? "") && url.host != nil)
    guard videoPresentation == nil, filePresentation == nil,
      let presenter = appContext?.utilities?.currentViewController(),
      isPlayableURL
    else {
      throw NSError(
        domain: "T3NativeVideo",
        code: 2,
        userInfo: [NSLocalizedDescriptionKey: "The video preview is no longer available."]
      )
    }
    let presentation = T3NativeVideoPresentation(identifier: identifier, url: url, title: title) { [weak self] error in
      self?.videoPresentation = nil
      if let error { promise.reject(error) } else { promise.resolve(nil) }
    }
    videoPresentation = presentation
    presentation.present(from: presenter, sources: presentationSources, sourceIdentifier: sourceIdentifier)
  }

  private func dismissVideoPresentation(identifier: String) {
    if videoPresentation?.identifier == identifier { videoPresentation?.dismiss() }
  }

  private func presentFile(url: URL, title: String, sourceIdentifier: String,
                           identifier: String, promise: Promise) throws {
    guard filePresentation == nil, videoPresentation == nil,
      let presenter = appContext?.utilities?.currentViewController()
    else { throw URLError(.cannotLoadFromNetwork) }
    let file = T3NativeFilePresentation(identifier: identifier, sources: presentationSources,
                                        sourceIdentifier: sourceIdentifier) { [weak self] error in
      self?.filePresentation = nil
      if let error { promise.reject(error) } else { promise.resolve(nil) }
    }
    filePresentation = file
    file.present(url: url, title: title, from: presenter)
  }

  private func dismissFilePresentation(identifier: String) {
    if filePresentation?.identifier == identifier { filePresentation?.dismiss() }
  }

  private func shareFile(url: URL, title: String, sourceIdentifier: String, promise: Promise) throws {
    guard let presenter = appContext?.utilities?.currentViewController() else {
      throw NSError(
        domain: "T3NativePresentation",
        code: 2,
        userInfo: [NSLocalizedDescriptionKey: "The presenting screen is no longer open."]
      )
    }
    try presentFileShare(
      url: url,
      title: title,
      source: presentationSources.view(for: sourceIdentifier),
      presenter: presenter,
      promise: promise
    )
  }
}
