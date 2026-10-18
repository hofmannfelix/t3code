import { describe, expect, it } from "vitest";

import { cleanTextForSpeech } from "./textForSpeech.ts";

describe("cleanTextForSpeech", () => {
  it("returns empty string when input is empty or nullish", () => {
    expect(cleanTextForSpeech("")).toBe("");
  });

  it("removes horizontal rules (---, ***, ___) so TTS does not stop prematurely", () => {
    const input = `Sentence before rule.

---

Sentence after rule.`;
    const result = cleanTextForSpeech(input);
    expect(result).not.toContain("---");
    expect(result).toBe("Sentence before rule.\n\nSentence after rule.");
  });

  it("replaces image tags with their alt text and removes local image URLs", () => {
    const input = "Look at this: ![Assembly overview](/Users/felix/assembly.png)";
    expect(cleanTextForSpeech(input)).toBe("Look at this: Assembly overview.");
  });

  it("removes image tags completely if alt text is empty", () => {
    const input = "Empty image: ![](/Users/felix/image.png)";
    expect(cleanTextForSpeech(input)).toBe("Empty image:");
  });

  it("cleans markdown link syntax leaving only the link text", () => {
    const input = "Refer to [`params.scad`](file:///path/to/params.scad) for details.";
    expect(cleanTextForSpeech(input)).toBe("Refer to params.scad for details.");
  });

  it("cleans headers and bold/italic markup", () => {
    const input = `### Section Header
* **Important:** this is **bold** and __underlined__.`;
    expect(cleanTextForSpeech(input)).toBe(
      `Section Header\n* Important: this is bold and underlined.`,
    );
  });

  it("cleans LaTeX inline math expressions", () => {
    const input = "The $2\\text{ mm}$ inner radius remains unchanged.";
    expect(cleanTextForSpeech(input)).toBe("The 2 mm inner radius remains unchanged.");
  });

  it("removes code fences while keeping code content", () => {
    const input = `Code:
\`\`\`ts
const value = 123;
\`\`\`
Done.`;
    expect(cleanTextForSpeech(input)).toBe("Code:\n\nconst value = 123;\n\nDone.");
  });

  it("handles the user's exact PullUpHandles turn text without stopping or exposing paths", () => {
    const pullUpHandlesText = `Die Platten- und Wandstärke wurde in [\`params.scad\`](file:///Users/felix/Projects/openscad/PullUpHandles/params.scad) wieder auf **12 mm** zurückgesetzt:

### Aktualisierte Parameter
* **\`platten_dicke = 12;\`** (Materialstärke jeder Hängeplatte wieder 12 mm)
* **\`wandstaerke = 12;\`** (Wandstärke um den Träger oben, links und unten wieder 12 mm)
* **\`abrundung_innen = 2;\`** (Die $2\\text{ mm}$ Innenverrundungen an den Kanten E3 & E4 bleiben voll erhalten)
* **Lastkern:** Hat sich automatisch wieder auf die kompaktere Gesamtlänge von **\`146 mm\`** verkürzt.

---

### Visuelle Vorschau

![Gesamt-Assembly mit 12 mm Stärke am Träger](/Users/felix/.t3/userdata/providers/antigravity/ac0a3dfd6dddb20962cecff6ee5fe65e19d3923be20e52c5ab52ff877f7e4c32/antigravity-acp/brain/4da1daff-6781-46f2-b971-19fe191a2435/assembly_12mm.png)

![Hängeplatte mit 12 mm Stärke und 2 mm Innenverrundung](/Users/felix/.t3/userdata/providers/antigravity/ac0a3dfd6dddb20962cecff6ee5fe65e19d3923be20e52c5ab52ff877f7e4c32/antigravity-acp/brain/4da1daff-6781-46f2-b971-19fe191a2435/haengeplatte_12mm.png)

![Kompaktes Drucklayout für das Druckbett](/Users/felix/.t3/userdata/providers/antigravity/ac0a3dfd6dddb20962cecff6ee5fe65e19d3923be20e52c5ab52ff877f7e4c32/antigravity-acp/brain/4da1daff-6781-46f2-b971-19fe191a2435/drucklayout_12mm.png)

Damit spart das System rund **35 % Filament und Druckzeit** ein, bleibt kompakter für den Transport und ist mit **620 kg (PETG)** bzw. **> 1,5 Tonnen (PPA-CF)** Bruchlast weiterhin absolut sicher. Alle SCAD-Dateien sind aktualisiert.

Die Renderings mit den schlanken **12 mm** Maßen und den erhaltenen **2 mm Innenverrundungen** wurden erfolgreich abgeschlossen. Das Projekt ist konsistent auf Stand und bereit für den Export/Druck.`;

    const cleaned = cleanTextForSpeech(pullUpHandlesText);
    expect(cleaned).not.toContain("---");
    expect(cleaned).not.toContain("/Users/felix/");
    expect(cleaned).not.toContain("file:///");
    expect(cleaned).toContain("Gesamt-Assembly mit 12 mm Stärke am Träger");
    expect(cleaned).toContain("bereit für den Export/Druck");
    expect(cleaned.startsWith("Die Platten- und Wandstärke wurde in params.scad")).toBe(true);
  });
});
