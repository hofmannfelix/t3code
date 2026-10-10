# Read aloud

Any finished agent reply can be read aloud: hover a message and press the speaker
button next to Copy. Press again to stop, or scroll the message away. Reading one
message stops the previous one.

By default your device's built-in voices do the reading. For natural-sounding
voices, connect a text-to-speech provider in Settings → Integrations → Read
aloud: any OpenAI-compatible speech endpoint works, which covers OpenAI, Groq,
and self-hosted gateways. The API key is stored on the server, so every device
connected to that server reads with the same voices. When the provider is
unreachable, T3 Code falls back to the device voices for that message.
