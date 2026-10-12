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
