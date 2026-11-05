# Read aloud

Any finished agent reply can be read aloud: hover a message and press the speaker
button next to Copy. Press again to stop, or scroll the message away. Reading one
message stops the previous one.

To have every new reply read automatically, enable **Read new replies aloud**
in Settings → Integrations → Read aloud. Finished replies then line up in a
queue and are spoken one after another; a manual read takes over and clears
the queue, and switching threads silences the old conversation's backlog.

By default your device's built-in voices do the reading. For natural-sounding
voices, connect a text-to-speech provider in Settings → Integrations → Read
aloud. Two provider shapes are supported: **Google Gemini** (free tier
available, top-tier quality, German included — pick the Gemini provider, add an
AI Studio API key, and the defaults just work) and any **OpenAI-compatible**
speech endpoint, which covers OpenAI, Groq, and self-hosted gateways. The API
key is stored on the server, so every device connected to that server reads
with the same voices. When the provider is unreachable, T3 Code falls back to
the device voices for that message. If even those cannot play, a toast says so
instead of staying silent.

## Short updates on mobile

In the mobile app, the audio bar shows a **Kurz** switch while it plays or waits for
a thread. Turn it on, and that thread's automatic replies are read as a one- or
two-sentence spoken summary. Tapping the speaker on a message still reads it in
full. The summary uses the read-aloud provider's key: Gemini on the device, or the
server's provider (Gemini or OpenAI). If the summary cannot be made in time, the
full reply is read instead.

## Spoken language

Under Settings → Voice & read aloud → Spoken language, choose **Deutsch** or
**English** to steer the voice toward that language. It is a hint, not a lock:
passages clearly in another language keep their own pronunciation. With
**Automatic**, the voice follows each reply's text.

## Which microphone records

While you dictate, the composer shows the name of the microphone that is
recording. To prefer the iPhone microphone over a connected headset, move it to the
top of Settings → Microphone.
