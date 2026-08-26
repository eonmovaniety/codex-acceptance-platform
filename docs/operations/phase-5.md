# Phase 5 operations: test data and visual MVP

Each Run receives a fresh runtime-owned test-data root with four explicit layers:

```text
runtime/<run>/test-data/
├── base/
├── scenario/
├── edge/
└── visual/
```

`TestDataManager` executes optional shell-free reset and seed commands, writes a marker, and records the data version. The runtime and its marker are owned by the Run and are removed by the existing lease-aware cleanup path.

## Visual cases

`VisualCase` contains a route, named states, and explicit viewports. The same `VisualCaptureAdapter` contract is used for Web and Android; the current deterministic adapter is an offline fixture adapter and is intentionally not a claim of real-device acceptance.

Enable a project visual case with:

```yaml
visual:
  enabled: true
  platform: web
  cases:
    - .acceptance/visual/settings.yaml
  baseline: true
```

Screenshots are stored inside the Run as raw RGBA fixture artifacts plus metadata. The baseline cache is separate. A missing or changed baseline creates a pending Baseline Request and a `HUMAN` Gate trigger; capture never overwrites the baseline. Only an explicit human approval can update it.

The deterministic fixture proves repeatability and data-version sensitivity. Platform-specific Web/Android capture, device/emulator interaction, and perceptual image metrics remain adapters for a later acceptance environment.
