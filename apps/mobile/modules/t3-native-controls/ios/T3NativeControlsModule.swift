import AVFoundation
import ExpoModulesCore
import MediaPlayer
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
    T3NativeSpeechSynthesizer.shared.isSpeechSynthesizerActive = false
    if T3NativeSpeechSynthesizer.shared.keepSessionActiveOnFinish {
      T3NativeSpeechSynthesizer.shared.setupRemoteCommands()
      T3NativeSpeechSynthesizer.shared.resumeBackgroundAudio()
      var nowPlaying = [String: Any]()
      nowPlaying[MPMediaItemPropertyTitle] = "Warte auf Antwort..."
      let artistName = T3NativeSpeechSynthesizer.shared.activeProjectTitle ?? "T3 Code"
      nowPlaying[MPMediaItemPropertyArtist] = artistName
      nowPlaying[MPNowPlayingInfoPropertyPlaybackRate] = 1.0
      MPNowPlayingInfoCenter.default().nowPlayingInfo = nowPlaying
      T3NativeSpeechSynthesizer.shared.notifyPhaseChange("waiting")
    } else {
      T3NativeSpeechSynthesizer.shared.stopBackgroundAudio()
      MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
      try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
      T3NativeSpeechSynthesizer.shared.notifyPhaseChange("idle")
    }
    onFinish()
  }

  func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
    T3NativeSpeechSynthesizer.shared.isSpeechSynthesizerActive = false
    if !T3NativeSpeechSynthesizer.shared.keepSessionActiveOnFinish {
      T3NativeSpeechSynthesizer.shared.stopBackgroundAudio()
      MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
      try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
      T3NativeSpeechSynthesizer.shared.notifyPhaseChange("idle")
    }
    onFinish()
  }

  func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didPause utterance: AVSpeechUtterance) {
    T3NativeSpeechSynthesizer.shared.notifyPhaseChange("paused")
  }

  func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didContinue utterance: AVSpeechUtterance) {
    T3NativeSpeechSynthesizer.shared.notifyPhaseChange("playing")
  }
}

public final class T3NativeSpeechSynthesizer: NSObject {
  public static let shared = T3NativeSpeechSynthesizer()
  private let synthesizer = AVSpeechSynthesizer()
  private var activeDelegate: T3SpeechSynthesizerDelegate?
  private var backgroundAudioPlayer: AVAudioPlayer?
  public var onPhaseChange: ((String) -> Void)?
  public var onRemoteCommand: ((String) -> Void)?
  public var activeProjectTitle: String?
  public var keepSessionActiveOnFinish: Bool = false
  public var isSpeechSynthesizerActive: Bool = false
  public var waitingAudioMode: String = "music"

  public func setWaitingAudioMode(_ mode: String) {
    let modeChanged = (self.waitingAudioMode != mode)
    self.waitingAudioMode = mode
    if modeChanged && backgroundAudioPlayer != nil {
      let wasPlaying = backgroundAudioPlayer?.isPlaying ?? false
      stopBackgroundAudio()
      if wasPlaying {
        startBackgroundAudio()
      }
    }
  }

  public func notifyRemoteCommand(_ command: String) {
    DispatchQueue.main.async { [weak self] in
      self?.onRemoteCommand?(command)
    }
  }

  private override init() {
    super.init()
    setupRemoteCommands()
  }

  public func setupRemoteCommands() {
    let commandCenter = MPRemoteCommandCenter.shared()
    commandCenter.pauseCommand.removeTarget(nil)
    commandCenter.pauseCommand.isEnabled = true
    commandCenter.pauseCommand.addTarget { [weak self] _ in
      self?.pause()
      return .success
    }
    commandCenter.playCommand.removeTarget(nil)
    commandCenter.playCommand.isEnabled = true
    commandCenter.playCommand.addTarget { [weak self] _ in
      self?.resume()
      return .success
    }
    commandCenter.togglePlayPauseCommand.removeTarget(nil)
    commandCenter.togglePlayPauseCommand.isEnabled = true
    commandCenter.togglePlayPauseCommand.addTarget { [weak self] _ in
      guard let self = self else { return .commandFailed }
      if let bg = self.backgroundAudioPlayer, bg.isPlaying {
        self.pause()
      } else if self.isSpeechSynthesizerActive && !self.synthesizer.isPaused {
        self.pause()
      } else if self.isSpeechSynthesizerActive && self.synthesizer.isPaused {
        self.resume()
      } else if self.backgroundAudioPlayer != nil && !self.backgroundAudioPlayer!.isPlaying {
        self.resume()
      } else {
        self.notifyRemoteCommand("toggle")
      }
      return .success
    }

    commandCenter.stopCommand.removeTarget(nil)
    commandCenter.stopCommand.isEnabled = true
    commandCenter.stopCommand.addTarget { [weak self] _ in
      guard let self = self else { return .commandFailed }
      self.stop(forceDeactivate: true)
      self.notifyRemoteCommand("stop")
      return .success
    }

    commandCenter.previousTrackCommand.removeTarget(nil)
    commandCenter.previousTrackCommand.isEnabled = true
    commandCenter.previousTrackCommand.addTarget { [weak self] _ in
      guard let self = self else { return .commandFailed }
      if let bg = self.backgroundAudioPlayer {
        bg.currentTime = 0
        if !bg.isPlaying && self.keepSessionActiveOnFinish {
          bg.play()
        }
      }
      self.notifyRemoteCommand("previousTrack")
      return .success
    }

    commandCenter.skipBackwardCommand.removeTarget(nil)
    commandCenter.skipBackwardCommand.preferredIntervals = [10.0]
    commandCenter.skipBackwardCommand.isEnabled = true
    commandCenter.skipBackwardCommand.addTarget { [weak self] _ in
      guard let self = self else { return .commandFailed }
      if let bg = self.backgroundAudioPlayer {
        bg.currentTime = max(0, bg.currentTime - 10.0)
      }
      self.notifyRemoteCommand("skipBackward")
      return .success
    }

    commandCenter.skipForwardCommand.removeTarget(nil)
    commandCenter.skipForwardCommand.preferredIntervals = [10.0]
    commandCenter.skipForwardCommand.isEnabled = true
    commandCenter.skipForwardCommand.addTarget { [weak self] _ in
      guard let self = self else { return .commandFailed }
      if let bg = self.backgroundAudioPlayer {
        bg.currentTime = min(bg.duration, bg.currentTime + 10.0)
      }
      self.notifyRemoteCommand("skipForward")
      return .success
    }
  }

  public func notifyPhaseChange(_ phase: String) {
    DispatchQueue.main.async { [weak self] in
      self?.onPhaseChange?(phase)
    }
  }

  public func startBackgroundAudio() {
    if backgroundAudioPlayer == nil {
      if waitingAudioMode == "silent" {
        do {
          let player = try AVAudioPlayer(data: T3SilentAudio.audioData, fileTypeHint: AVFileType.wav.rawValue)
          player.numberOfLoops = -1
          player.volume = 1.0
          player.prepareToPlay()
          backgroundAudioPlayer = player
        } catch {
          NSLog("[T3NativeSpeechSynthesizer] Failed to create silent audio player: \(error)")
        }
      } else if let data = T3ElevatorMusic.audioData {
        do {
          let player = try AVAudioPlayer(data: data, fileTypeHint: AVFileType.m4a.rawValue)
          player.numberOfLoops = -1
          player.volume = 0.22
          player.prepareToPlay()
          backgroundAudioPlayer = player
        } catch {
          NSLog("[T3NativeSpeechSynthesizer] Failed to create elevator music player: \(error)")
        }
      }
    }
    backgroundAudioPlayer?.play()
  }

  public func pauseBackgroundAudio() {
    backgroundAudioPlayer?.pause()
  }

  public func resumeBackgroundAudio() {
    do {
      let audioSession = AVAudioSession.sharedInstance()
      try audioSession.setCategory(.playback, mode: .default, options: [])
      try audioSession.setActive(true, options: .notifyOthersOnDeactivation)
    } catch {
      NSLog("[T3NativeSpeechSynthesizer] Audio session resume error: \(error)")
    }
    if backgroundAudioPlayer == nil {
      startBackgroundAudio()
    } else {
      backgroundAudioPlayer?.play()
    }
  }

  public func stopBackgroundAudio() {
    backgroundAudioPlayer?.stop()
    backgroundAudioPlayer = nil
  }

  public func activateSession(title: String? = nil, projectTitle: String? = nil) {
    self.activeProjectTitle = projectTitle
    self.keepSessionActiveOnFinish = true

    do {
      let audioSession = AVAudioSession.sharedInstance()
      try audioSession.setCategory(.playback, mode: .default, options: [])
      try audioSession.setActive(true, options: .notifyOthersOnDeactivation)
    } catch {
      NSLog("[T3NativeSpeechSynthesizer] Audio session activation error: \(error)")
    }

    startBackgroundAudio()

    var nowPlaying = [String: Any]()
    nowPlaying[MPMediaItemPropertyTitle] = "Warte auf Antwort..."
    let artistName = projectTitle ?? "T3 Code"
    nowPlaying[MPMediaItemPropertyArtist] = artistName
    nowPlaying[MPNowPlayingInfoPropertyPlaybackRate] = 1.0
    MPNowPlayingInfoCenter.default().nowPlayingInfo = nowPlaying
    notifyPhaseChange("waiting")
  }

  public func speak(
    text: String,
    title: String? = nil,
    projectTitle: String? = nil,
    language: String? = nil,
    pitch: Float? = nil,
    rate: Float? = nil,
    voiceIdentifier: String? = nil,
    completion: @escaping () -> Void
  ) {
    if synthesizer.isSpeaking {
      synthesizer.stopSpeaking(at: .immediate)
    }

    pauseBackgroundAudio()

    if let proj = projectTitle {
      self.activeProjectTitle = proj
    }

    isSpeechSynthesizerActive = true
    setupRemoteCommands()

    let utterance = AVSpeechUtterance(string: text)

    if let voiceIdentifier = voiceIdentifier,
       let voice = AVSpeechSynthesisVoice(identifier: voiceIdentifier) {
      utterance.voice = voice
    } else if let language = language,
              let voice = AVSpeechSynthesisVoice(language: language) {
      utterance.voice = voice
    } else {
      utterance.voice = AVSpeechSynthesisVoice(language: "de-DE") ?? AVSpeechSynthesisVoice(language: AVSpeechSynthesisVoice.currentLanguageCode())
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
      try audioSession.setCategory(.playback, mode: .default, options: [])
      try audioSession.setActive(true, options: .notifyOthersOnDeactivation)
    } catch {
      NSLog("[T3NativeSpeechSynthesizer] Audio session activation error: \(error)")
    }

    var nowPlaying = [String: Any]()
    nowPlaying[MPMediaItemPropertyTitle] = title ?? "Antwort"
    let artistName = projectTitle != nil ? projectTitle! : (self.activeProjectTitle ?? "T3 Code")
    nowPlaying[MPMediaItemPropertyArtist] = artistName
    nowPlaying[MPNowPlayingInfoPropertyPlaybackRate] = 1.0
    MPNowPlayingInfoCenter.default().nowPlayingInfo = nowPlaying

    synthesizer.speak(utterance)
    notifyPhaseChange("playing")
  }

  public func stop(forceDeactivate: Bool = true) {
    isSpeechSynthesizerActive = false
    if synthesizer.isSpeaking {
      synthesizer.stopSpeaking(at: .immediate)
    }
    if forceDeactivate {
      stopBackgroundAudio()
      keepSessionActiveOnFinish = false
      activeProjectTitle = nil
      MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
      try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
    } else if keepSessionActiveOnFinish {
      setupRemoteCommands()
      resumeBackgroundAudio()
      var nowPlaying = [String: Any]()
      nowPlaying[MPMediaItemPropertyTitle] = "Warte auf Antwort..."
      let artistName = activeProjectTitle ?? "T3 Code"
      nowPlaying[MPMediaItemPropertyArtist] = artistName
      nowPlaying[MPNowPlayingInfoPropertyPlaybackRate] = 1.0
      MPNowPlayingInfoCenter.default().nowPlayingInfo = nowPlaying
    }
    activeDelegate = nil
    notifyPhaseChange(forceDeactivate ? "idle" : "waiting")
  }

  public func pause() {
    if let bg = backgroundAudioPlayer, bg.isPlaying {
      pauseBackgroundAudio()
    }
    if isSpeechSynthesizerActive && !synthesizer.isPaused {
      synthesizer.pauseSpeaking(at: .immediate)
    }
    if var nowPlaying = MPNowPlayingInfoCenter.default().nowPlayingInfo {
      nowPlaying[MPNowPlayingInfoPropertyPlaybackRate] = 0.0
      MPNowPlayingInfoCenter.default().nowPlayingInfo = nowPlaying
    }
    notifyPhaseChange("paused")
    notifyRemoteCommand("pause")
  }

  public func resume() {
    if isSpeechSynthesizerActive && synthesizer.isPaused {
      synthesizer.continueSpeaking()
      if var nowPlaying = MPNowPlayingInfoCenter.default().nowPlayingInfo {
        nowPlaying[MPNowPlayingInfoPropertyPlaybackRate] = 1.0
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nowPlaying
      }
      notifyPhaseChange("playing")
    } else if keepSessionActiveOnFinish {
      setupRemoteCommands()
      resumeBackgroundAudio()
      var nowPlaying = [String: Any]()
      nowPlaying[MPMediaItemPropertyTitle] = "Warte auf Antwort..."
      let artistName = activeProjectTitle ?? "T3 Code"
      nowPlaying[MPMediaItemPropertyArtist] = artistName
      nowPlaying[MPNowPlayingInfoPropertyPlaybackRate] = 1.0
      MPNowPlayingInfoCenter.default().nowPlayingInfo = nowPlaying
      notifyPhaseChange("waiting")
    }
    notifyRemoteCommand("play")
  }

  public var isSpeaking: Bool {
    return synthesizer.isSpeaking
  }

  public var isPaused: Bool {
    return synthesizer.isPaused
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
    Events("onSpeechPhaseChanged", "onRemoteCommand")

    OnStartObserving {
      T3NativeSpeechSynthesizer.shared.onPhaseChange = { [weak self] phase in
        self?.sendEvent("onSpeechPhaseChanged", ["phase": phase])
      }
      T3NativeSpeechSynthesizer.shared.onRemoteCommand = { [weak self] command in
        self?.sendEvent("onRemoteCommand", ["command": command])
      }
    }

    OnStopObserving {
      T3NativeSpeechSynthesizer.shared.onPhaseChange = nil
      T3NativeSpeechSynthesizer.shared.onRemoteCommand = nil
    }

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

    AsyncFunction("activateAudioSession") { (options: [String: Any]?, promise: Promise) in
      let title = options?["title"] as? String
      let projectTitle = options?["projectTitle"] as? String
      if let mode = options?["waitingAudioMode"] as? String {
        T3NativeSpeechSynthesizer.shared.waitingAudioMode = mode
      }
      T3NativeSpeechSynthesizer.shared.setupRemoteCommands()
      T3NativeSpeechSynthesizer.shared.activateSession(title: title, projectTitle: projectTitle)
      promise.resolve(true)
    }.runOnQueue(.main)

    AsyncFunction("setWaitingAudioMode") { (mode: String, promise: Promise) in
      T3NativeSpeechSynthesizer.shared.setWaitingAudioMode(mode)
      promise.resolve(nil)
    }.runOnQueue(.main)

    AsyncFunction("speakText") { (text: String, options: [String: Any]?, promise: Promise) in
      let language = options?["language"] as? String
      let pitch = (options?["pitch"] as? NSNumber)?.floatValue
      let rate = (options?["rate"] as? NSNumber)?.floatValue
      let voice = options?["voice"] as? String
      let title = options?["title"] as? String
      let projectTitle = options?["projectTitle"] as? String

      T3NativeSpeechSynthesizer.shared.speak(
        text: text,
        title: title,
        projectTitle: projectTitle,
        language: language,
        pitch: pitch,
        rate: rate,
        voiceIdentifier: voice
      ) {
        promise.resolve(nil)
      }
    }.runOnQueue(.main)

    AsyncFunction("stopSpeaking") { (promise: Promise) in
      T3NativeSpeechSynthesizer.shared.stop(forceDeactivate: false)
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

    AsyncFunction("pauseWaitingAudio") { (promise: Promise) in
      T3NativeSpeechSynthesizer.shared.pauseBackgroundAudio()
      if var nowPlaying = MPNowPlayingInfoCenter.default().nowPlayingInfo {
        nowPlaying[MPNowPlayingInfoPropertyPlaybackRate] = 0.0
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nowPlaying
      }
      T3NativeSpeechSynthesizer.shared.notifyPhaseChange("paused")
      promise.resolve(nil)
    }.runOnQueue(.main)

    AsyncFunction("resumeWaitingAudio") { (options: [String: Any]?, promise: Promise) in
      let projectTitle = options?["projectTitle"] as? String
      let title = options?["title"] as? String ?? "Warte auf Antwort..."
      if let proj = projectTitle {
        T3NativeSpeechSynthesizer.shared.activeProjectTitle = proj
      }
      T3NativeSpeechSynthesizer.shared.setupRemoteCommands()
      T3NativeSpeechSynthesizer.shared.resumeBackgroundAudio()
      var nowPlaying = [String: Any]()
      nowPlaying[MPMediaItemPropertyTitle] = title
      let artistName = projectTitle ?? (T3NativeSpeechSynthesizer.shared.activeProjectTitle ?? "T3 Code")
      nowPlaying[MPMediaItemPropertyArtist] = artistName
      nowPlaying[MPNowPlayingInfoPropertyPlaybackRate] = 1.0
      MPNowPlayingInfoCenter.default().nowPlayingInfo = nowPlaying
      T3NativeSpeechSynthesizer.shared.notifyPhaseChange("waiting")
      promise.resolve(nil)
    }.runOnQueue(.main)

    AsyncFunction("deactivateAudioSession") { (promise: Promise) in
      T3NativeSpeechSynthesizer.shared.stop(forceDeactivate: true)
      MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
      try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
      promise.resolve(true)
    }.runOnQueue(.main)

    AsyncFunction("enforceBuiltInMicrophone") { (promise: Promise) in
      let session = AVAudioSession.sharedInstance()
      guard let inputs = session.availableInputs else {
        promise.resolve(false)
        return
      }
      if let builtInMic = inputs.first(where: { $0.portType == .builtInMic }) {
        do {
          try session.setPreferredInput(builtInMic)
          promise.resolve(true)
        } catch {
          promise.resolve(false)
        }
      } else {
        promise.resolve(false)
      }
    }

    AsyncFunction("resetPreferredAudioInput") { (promise: Promise) in
      do {
        try AVAudioSession.sharedInstance().setPreferredInput(nil)
        promise.resolve(true)
      } catch {
        promise.resolve(false)
      }
    }

    Function("isSpeaking") { () -> Bool in
      return T3NativeSpeechSynthesizer.shared.isSpeaking
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
    let scenePath = NSHomeDirectory() + "/Library/Caches/T3ShowcaseReadyScene"
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


public enum T3SilentAudio {
  public static var audioData: Data {
    let sampleRate: Int32 = 8000
    let numChannels: Int16 = 1
    let bitsPerSample: Int16 = 16
    let byteRate: Int32 = sampleRate * Int32(numChannels) * Int32(bitsPerSample / 8)
    let blockAlign: Int16 = numChannels * (bitsPerSample / 8)
    let numSamples: Int32 = sampleRate * 2 // 2 seconds of silence
    let dataSize: Int32 = numSamples * Int32(blockAlign)
    let chunkSize: Int32 = 36 + dataSize

    var data = Data()
    data.append(contentsOf: [0x52, 0x49, 0x46, 0x46]) // "RIFF"
    var chunkLE = chunkSize.littleEndian
    data.append(Data(bytes: &chunkLE, count: MemoryLayout<Int32>.size))
    data.append(contentsOf: [0x57, 0x41, 0x56, 0x45]) // "WAVE"
    data.append(contentsOf: [0x66, 0x6D, 0x74, 0x20]) // "fmt "
    var subchunk1LE = Int32(16).littleEndian
    data.append(Data(bytes: &subchunk1LE, count: MemoryLayout<Int32>.size))
    var formatLE = Int16(1).littleEndian
    data.append(Data(bytes: &formatLE, count: MemoryLayout<Int16>.size))
    var channelsLE = numChannels.littleEndian
    data.append(Data(bytes: &channelsLE, count: MemoryLayout<Int16>.size))
    var rateLE = sampleRate.littleEndian
    data.append(Data(bytes: &rateLE, count: MemoryLayout<Int32>.size))
    var byteRateLE = byteRate.littleEndian
    data.append(Data(bytes: &byteRateLE, count: MemoryLayout<Int32>.size))
    var alignLE = blockAlign.littleEndian
    data.append(Data(bytes: &alignLE, count: MemoryLayout<Int16>.size))
    var bitsLE = bitsPerSample.littleEndian
    data.append(Data(bytes: &bitsLE, count: MemoryLayout<Int16>.size))
    data.append(contentsOf: [0x64, 0x61, 0x74, 0x61]) // "data"
    var dataSizeLE = dataSize.littleEndian
    data.append(Data(bytes: &dataSizeLE, count: MemoryLayout<Int32>.size))
    data.append(Data(count: Int(dataSize)))
    return data
  }
}

public enum T3ElevatorMusic {
  public static let base64Data: String = "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ALkAAAC1AAAAsgAAAQcAAADgAAAAhQAAAJYAAAC8AAAAtQAAALIAAADCAAAAvAAAALoAAAC5AAAAuwAAAKwAAAD+AAAAlgAAAKsAAAC0AAAAuwAAAMIAAADCAAAAvgAAALUAAAC4AAAAvAAAAKEAAADvAAAAqwAAAKoAAACoAAAAugAAALQAAADIAAAAwAAAAKcAAAEJAAAAkgAAAMYAAADuAAAAmAAAAKAAAAC1AAAAuQAAALMAAAC+AAAAuAAAAL0AAAC5AAAAuwAAAMMAAACjAAABCQAAAKAAAACjAAAAtQAAAMkAAAC1AAAAtAAAALoAAAC8AAAApwAAARIAAADtAAAArQAAAJgAAACcAAAApgAAALcAAAC4AAAAsAAAALoAAAC/AAAAuAAAALoAAACYAAABHAAAAI8AAAClAAAArwAAAMkAAACaAAAAxwAAAMIAAADDAAAAuwAAAMUAAACvAAABAQAAAM8AAACLAAAApgAAALwAAAC1AAAAswAAALwAAAC/AAAAugAAALwAAAC4AAAAtgAAAPIAAACHAAAArAAAALcAAADNAAAAwQAAALwAAAC9AAAAswAAALwAAAC5AAAAuwAAAPIAAACaAAAAnQAAALIAAADGAAAAvwAAAL4AAAC1AAAAvwAAALgAAADKAAAAswAAAP4AAACXAAAAmwAAAKkAAACyAAABDwAAAPQAAADoAAAAoAAAAJ8AAACjAAAAuQAAAMUAAADMAAAApgAAAJUAAACkAAAAvwAAALoAAAC4AAAAtgAAALwAAAC7AAAAuwAAAI0AAAEaAAAAoQAAAJYAAACsAAAAzQAAAIIAAADRAAAAyQAAAMsAAADEAAAAwQAAAKsAAADtAAAAngAAAKUAAACuAAAAzwAAAMUAAADAAAAAvwAAAMAAAAC/AAAAvwAAAMIAAACkAAAA7QAAAKsAAACjAAAAqgAAAJYAAACaAAAAzQAAAMsAAADNAAAAzAAAAMUAAACUAAAA+gAAAKEAAACsAAAArwAAAMYAAACqAAAAxAAAAMQAAADAAAAAvgAAAMQAAACoAAABBQAAAKMAAAClAAAAsgAAAMkAAADIAAAAxwAAAMIAAADAAAAAvgAAAL4AAADAAAAAwAAAAQ0AAACyAAAAtAAAAM8AAADTAAAAzgAAAMYAAADDAAAAvwAAAMEAAADAAAAAsAAAAPsAAACkAAAAtQAAAKEAAACyAAAAqAAAAMEAAADHAAAAwQAAAMMAAADCAAAAlAAAAQMAAACdAAAAqAAAAKoAAADLAAAAygAAAKsAAAEWAAAApQAAAL0AAAC/AAAAngAAARcAAACaAAAAowAAAKUAAAC/AAAAsAAAALgAAADIAAAAwQAAAL0AAADCAAAAwwAAAP4AAADqAAAAFHN0Y28AAAAAAAAAAQAAACwAAAAac2dwZAEAAAByb2xsAAAAAgAAAAH//wAAABxzYmdwAAAAAHJvbGwAAAABAAABiwAAAAEAAABhdWR0YQAAAFltZXRhAAAAAAAAACFoZGxyAAAAAAAAAABtZGlyYXBwbAAAAAAAAAAAAAAAACxpbHN0AAAAJKl0b28AAAAcZGF0YQAAAAEAAAAATGF2ZjYxLjcuMTAw"
  
  public static var audioData: Data? {
    return Data(base64Encoded: base64Data)
  }
}
