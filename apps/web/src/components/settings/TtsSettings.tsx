import type { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button, InlineButton } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Switch } from "../ui/switch";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "tts-1";
const DEFAULT_VOICE = "alloy";

/**
 * Cloud voices for the clients' read-aloud action, using any OpenAI-compatible
 * speech endpoint. The API key is kept in the server's secret store and is
 * write-only: a saved key is never shown, only whether one is set. Without a
 * key, clients speak with their platform's own voices.
 */
export function TtsSettings({
  environmentId,
  onSaved,
}: {
  readonly environmentId: EnvironmentId;
  readonly onSaved: () => void;
}) {
  const tts = useEnvironmentSettings(environmentId, (settings) => settings.tts);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "save read-aloud settings",
  });
  const [drafts, setDrafts] = useState({ baseUrl: "", model: "", voice: "", apiKey: "" });
  const [saving, setSaving] = useState(false);
  const isKeySaved = tts.apiKey.length > 0;

  const save = async () => {
    setSaving(true);
    try {
      const result = await updateSettings({
        environmentId,
        input: {
          patch: {
            tts: {
              baseUrl: drafts.baseUrl.trim(),
              model: drafts.model.trim(),
              voice: drafts.voice.trim(),
              // An empty draft keeps what is saved; a typed value replaces or clears it.
              ...(drafts.apiKey.trim() ? { apiKey: drafts.apiKey.trim() } : {}),
            },
          },
        },
      });
      if (result._tag === "Success") {
        setDrafts({ baseUrl: "", model: "", voice: "", apiKey: "" });
        onSaved();
      }
    } finally {
      setSaving(false);
    }
  };

  const removeKey = async () => {
    setSaving(true);
    try {
      const result = await updateSettings({
        environmentId,
        input: { patch: { tts: { apiKey: "" } } },
      });
      if (result._tag === "Success") onSaved();
    } finally {
      setSaving(false);
    }
  };

  const setAutoReadAloud = async (checked: boolean) => {
    const result = await updateSettings({
      environmentId,
      input: { patch: { tts: { autoReadAloud: checked } } },
    });
    if (result._tag === "Success") onSaved();
  };

  const draft = (field: keyof typeof drafts) => (value: string) =>
    setDrafts((current) => ({ ...current, [field]: value }));

  return (
    <form
      className="grid gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="grid gap-0.5">
          <Label htmlFor={`tts-auto-read-${environmentId}`}>Read new replies aloud</Label>
          <p className="text-xs text-muted-foreground">
            Automatically speaks every finished reply, one after another. A manual read still takes
            over and clears the queue.
          </p>
        </div>
        <Switch
          id={`tts-auto-read-${environmentId}`}
          checked={tts.autoReadAloud}
          onCheckedChange={(checked) => void setAutoReadAloud(checked)}
        />
      </div>
      {/* Locked while saving: a successful save clears the drafts, which would drop edits made mid-request. */}
      <fieldset disabled={saving} className="contents">
        <p className="max-w-2xl text-xs leading-relaxed text-muted-foreground">
          Read-aloud uses an OpenAI-compatible speech endpoint; empty fields fall back to{" "}
          <code className="rounded bg-muted px-1 py-px text-2xs">{DEFAULT_BASE_URL}</code> with the{" "}
          <code className="rounded bg-muted px-1 py-px text-2xs">{DEFAULT_MODEL}</code> voice{" "}
          <code className="rounded bg-muted px-1 py-px text-2xs">{DEFAULT_VOICE}</code>. Without an
          API key, messages are read with this device's own voices instead.{" "}
          <InlineButton
            render={
              <a
                href="https://platform.openai.com/account/api-keys"
                target="_blank"
                rel="noreferrer noopener"
              />
            }
          >
            Create an API key
          </InlineButton>
        </p>
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="grid gap-1.5">
            <Label htmlFor={`tts-base-url-${environmentId}`}>Base URL</Label>
            <Input
              id={`tts-base-url-${environmentId}`}
              autoComplete="off"
              size="sm"
              placeholder={DEFAULT_BASE_URL}
              value={drafts.baseUrl}
              onChange={(event) => draft("baseUrl")(event.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`tts-model-${environmentId}`}>Model</Label>
            <Input
              id={`tts-model-${environmentId}`}
              autoComplete="off"
              size="sm"
              placeholder={DEFAULT_MODEL}
              value={drafts.model}
              onChange={(event) => draft("model")(event.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`tts-voice-${environmentId}`}>Voice</Label>
            <Input
              id={`tts-voice-${environmentId}`}
              autoComplete="off"
              size="sm"
              placeholder={DEFAULT_VOICE}
              value={drafts.voice}
              onChange={(event) => draft("voice")(event.target.value)}
            />
          </div>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`tts-api-key-${environmentId}`}>API key</Label>
          <Input
            id={`tts-api-key-${environmentId}`}
            type="password"
            autoComplete="off"
            size="sm"
            placeholder={isKeySaved ? "Stored secret, enter a new value to replace" : "Not set"}
            value={drafts.apiKey}
            onChange={(event) => draft("apiKey")(event.target.value)}
          />
        </div>
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            {isKeySaved
              ? "A key is saved on the server; cloud voices are used where available."
              : "No key saved; read-aloud uses this device's voices."}
          </p>
          <div className="flex shrink-0 gap-2">
            {isKeySaved ? (
              <Button
                size="xs"
                variant="outline"
                disabled={saving}
                onClick={() => void removeKey()}
              >
                Remove key
              </Button>
            ) : null}
            <Button type="submit" size="xs" disabled={saving}>
              Save
            </Button>
          </div>
        </div>
      </fieldset>
    </form>
  );
}
