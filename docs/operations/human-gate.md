# Human Gate operations

Inspect baseline requests with:

```powershell
npm run acceptance -- human list --json
npm run acceptance -- human show <request-id> --json
```

For a baseline request, the explicit decision is the only path that can update the separate baseline cache:

```powershell
npm run acceptance -- human decide <request-id> --approve --json
npm run acceptance -- human decide <request-id> --reject --json
npm run acceptance -- human decide <request-id> --defer --json
```

Approval reads the candidate bytes from the immutable Run artifact. Reviewer or Builder code has no baseline-overwrite operation.
