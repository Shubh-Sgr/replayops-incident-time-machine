---
name: ReplayOps
description: A calibrated incident time machine for evidence-led production response.
colors:
  primary: "oklch(67.5% 0.185 46)"
  primary-ink: "oklch(22.5% 0.038 42)"
  info: "oklch(63% 0.125 221)"
  success: "oklch(59% 0.118 157)"
  warning: "oklch(74% 0.135 78)"
  danger: "oklch(61% 0.19 27)"
  canvas: "oklch(95.5% 0.012 235)"
  rail: "oklch(91.5% 0.022 238)"
  panel: "oklch(98.2% 0.008 235)"
  elevated: "oklch(93.8% 0.018 236)"
  ink: "oklch(24.5% 0.038 244)"
  muted: "oklch(49% 0.034 241)"
  line: "oklch(82% 0.026 239)"
  dark-canvas: "oklch(18% 0.025 246)"
  dark-rail: "oklch(21.5% 0.032 245)"
  dark-panel: "oklch(23.5% 0.029 244)"
  dark-elevated: "oklch(27% 0.033 243)"
  dark-ink: "oklch(91% 0.018 235)"
  dark-muted: "oklch(69% 0.03 238)"
  dark-line: "oklch(34% 0.034 243)"
typography:
  display:
    fontFamily: "Outfit, sans-serif"
    fontSize: "clamp(3rem, 5vw, 3.75rem)"
    fontWeight: 600
    lineHeight: 1.02
    letterSpacing: "-0.035em"
  headline:
    fontFamily: "Outfit, sans-serif"
    fontSize: "clamp(1.875rem, 3vw, 2.25rem)"
    fontWeight: 600
    lineHeight: 1.11
    letterSpacing: "-0.03em"
  title:
    fontFamily: "Outfit, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 600
    lineHeight: 1.75
    letterSpacing: "-0.02em"
  body:
    fontFamily: "IBM Plex Sans, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "JetBrains Mono, monospace"
    fontSize: "0.75rem"
    fontWeight: 500
    lineHeight: 1.33
    letterSpacing: "-0.02em"
rounded:
  control: "10px"
  panel: "14px"
  status: "9999px"
spacing:
  "1": "4px"
  "2": "8px"
  "3": "12px"
  "4": "16px"
  "6": "24px"
  "8": "32px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-ink}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "0 16px"
    height: "44px"
  button-secondary:
    backgroundColor: "{colors.elevated}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "0 16px"
    height: "44px"
  field:
    backgroundColor: "{colors.elevated}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "0 14px"
    height: "44px"
  panel:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    rounded: "{rounded.panel}"
    padding: "24px"
---

# Design System: ReplayOps

## Overview

**Creative North Star: "The Industrial Chronograph Bench"**

ReplayOps feels like a calibrated instrument used under pressure: precise, legible, and deliberately quieter than the event it is helping diagnose. The world is built from cool blue-charcoal housings, pale instrument surfaces, incident-orange controls, measured traces, stable record stamps, and tabular readings.

The system is dense where evidence needs comparison and breathable around decisions. It rejects neon observability spectacle and generic AI-chat styling; assistant output is visually subordinate to the incident record.

**Key Characteristics:**

- Evidence-first hierarchy with the investigation summary and event timeline as the focal instruments.
- Cool hue-tinted neutrals in both light and dark themes.
- Sparse incident orange reserved for high-intent controls and active time.
- Human-readable operational copy paired with monospaced measurements.
- Restrained spring motion only where spatial continuity matters.

## Colors

The palette combines blue-tinted instrument neutrals with one warm control color and a compact set of semantic signal colors.

### Primary

- **Incident Orange:** The rare action and active-trace color used for primary controls, replay progress, and selected time.

### Secondary

- **Telemetry Cyan:** Supports measured traces, informational evidence, and neutral event markers.
- **Recovery Green:** Marks confirmed recovery and safe completion.
- **Caution Ochre:** Marks identified or monitoring states without competing with critical events.
- **Fault Red:** Reserved for critical severity, destructive actions, and errors.

### Neutral

- **Instrument Paper:** The light-mode field behind the operating surface.
- **Rail Blue-Gray:** Navigation rails, form wells, and subordinate regions.
- **Panel Porcelain:** The lightest bounded working surface.
- **Instrument Ink:** Primary light-mode text and dark controls.
- **Bay Blue-Black:** The dark-mode field and dominant product atmosphere.
- **Night Panel:** Slightly raised dark-mode working surfaces.
- **Calibration Line:** Dividers, lanes, and input boundaries; never a decorative frame.

### Named Rules

**The Ten-Percent Signal Rule.** Incident Orange occupies no more than roughly one tenth of a screen; its scarcity makes an active control or time marker immediately legible.

**The Tinted Neutral Rule.** Every neutral carries the primary blue hue. Unrelated pure gray, pure black, and pure white do not enter the interface.

## Typography

**Display Font:** Outfit (with sans-serif fallback)  
**Body Font:** IBM Plex Sans (with sans-serif fallback)  
**Label/Mono Font:** JetBrains Mono (with monospace fallback)

**Character:** Outfit supplies broad, decisive headings; IBM Plex Sans keeps dense operational copy technical without looking generic; JetBrains Mono is limited to values that benefit from fixed rhythm.

### Hierarchy

- **Display:** Large authentication statement only; tight tracking and compact leading.
- **Headline:** Page and primary incident headings; scales responsively from phone to desktop.
- **Title:** Section and drawer titles; compact enough for dense operating layouts.
- **Body:** Operational copy and controls; long explanatory text stays around 65–75 characters per line.
- **Label:** Timestamps, IDs, percentages, service readings, and keyboard hints; never decorative technical cosplay.

### Named Rules

**The Measurement Reserve Rule.** Monospace belongs only to time, identity, code-like evidence, and numeric measurement.

## Layout

The system follows a 4px base rhythm. Tight groups use 4–12px gaps, components use 16–24px, and major regions use 32px or more. Desktop uses a persistent 248px operations rail and a content frame capped at 1600px. Tablet collapses the rail into an overlay. Mobile becomes a single column with a bottom command dock and at least 24px of clearance above it.

The first product surface is an investigation inbox, not an analytics dashboard. Inside an investigation, the symptom, one useful next action, owner, freshness, and explanation precede the event timeline. Supporting comparisons and validation follow the evidence rather than preceding it.

## Elevation & Depth

Depth is primarily tonal. Most containers use either a one-pixel calibration border or one wide, soft offset shadow—never both. Drawers use a directional shadow to clarify that they slide over the evidence field; the sticky header uses backdrop blur only to preserve context while scrolling.

### Shadow Vocabulary

- **Instrument lift:** A soft vertical offset under the dominant incident surface.
- **Drawer separation:** A soft left-cast shadow for overlays entering from the right.
- **Focus ring:** A three-pixel blue-hued ring reserved for keyboard focus.

### Named Rules

**The One Depth Cue Rule.** A resting surface earns a border or a shadow, not both.

## Shapes

Controls use gently machined 10px corners. Panels use 14px corners. Full pills are reserved for status marks and trace nodes where the silhouette carries state. Lines remain one pixel; no colored side stripe substitutes for hierarchy.

The coordinate grid is exclusive to the causal trace because it encodes real service lanes and time. Cross-hatching is similarly semantic and appears only when evidence conflicts.

## Components

### Buttons

- **Shape:** Compact machined corners with a 44px minimum target.
- **Primary:** Incident Orange with dark warm ink and semibold copy.
- **Hover / Focus:** Small tonal change, then the shared blue-hued focus ring; no lift animation.
- **Secondary / Quiet:** Tonal neutral fills or transparent surfaces that strengthen on hover.

### Chips

- **Style:** Compact status marks pair an icon or dot with text; background is optional and color is never the only signal.
- **State:** Severity and workflow status maintain distinct vocabulary across dashboards and ledgers.

### Cards / Containers

- **Corner Style:** Gently rounded equipment housing.
- **Background:** Theme-specific panel or rail tokens.
- **Shadow Strategy:** Dominant surfaces may use instrument lift; ordinary ledgers use calibration borders.
- **Internal Padding:** 16px on phone, 20–24px from tablet upward.

### Inputs / Fields

- **Style:** Rail-toned fill, one-pixel calibration boundary, 10px corners, and a 44px minimum height.
- **Focus:** The field brightens to the panel token and receives the shared focus ring.
- **Error / Disabled:** Error copy names both the problem and recovery; disabled controls reduce opacity while retaining their label.

### Navigation

The desktop rail uses broad text labels and line icons with one inverted active row. Mobile moves three commands into a floating bottom dock; icon-only header actions retain accessible names.

### Event Timeline

The signature component maps services to horizontal lanes and evidence to real elapsed-time positions. A whole-incident density overview preserves context while the orange viewport marks the active time range. Responders can fit, zoom, pan, jump to recent windows, or center the selected event without inflating or horizontally scrolling the chart. When a narrowed range hides history, explicit earlier/later controls show the number of off-screen events and jump to the nearest hidden evidence; a previous-view control retraces range changes without losing context. The plot measures its container, adjusts tick and cluster density, and keeps endpoint markers inside the visible frame. Adaptive time ticks remain legible from seconds through months; collisions become count-bearing clusters, and incidents with many services retain the busiest lanes while grouping the remainder explicitly.

Selection synchronizes the URL, chart marker, and evidence inspector without moving the viewport away from the timeline. Counted clusters open an inline chooser and offer an explicit zoom action. The ledger follows the active window by default, but responders can switch to all evidence, search exact IDs or content, filter by service/type/state, sort, and paginate. A single persistent inspector carries detail and correction actions so repeated rows remain scan-first. Desktop uses a semantic data table; phones use touch-sized evidence rows and the same filtering model. Arrow keys move across events, bracket keys pan time, and every chart marker exposes a complete text label.

## Do's and Don'ts

### Do:

- **Do** lead incident surfaces with customer symptom, unknowns, one next action, freshness, and exact evidence.
- **Do** use semantic OKLCH tokens and keep neutrals inside the blue instrument family.
- **Do** label observations, explanations, scenario estimates, executed replay, AI uncertainty, and human-approval boundaries explicitly.
- **Do** retain 44px touch targets, visible focus, reduced-motion behavior, and text alternatives for charts.

### Don't:

- **Don't** use Inter, Roboto, generic purple-to-blue gradients, gradient text, pure black, or pure white-on-gray nesting.
- **Don't** turn every metric into a card, add decorative sparklines, or nest framed panels without a real information boundary.
- **Don't** use the trace grid, cross-hatching, or monospaced type as ambient decoration.
- **Don't** make AI answers visually outrank the evidence that grounds them.
