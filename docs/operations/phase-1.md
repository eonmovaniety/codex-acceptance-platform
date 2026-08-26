# Phase 1 operations

Set `CAP_ACCEPTANCE_HOME` to a managed directory, then initialize the SQLite state:

```powershell
$env:CAP_ACCEPTANCE_HOME = "C:\cap-state"
npm run acceptance -- init --json
npm run acceptance -- doctor --json
```

Register and validate a target project:

```powershell
npm run acceptance -- project add C:\path\to\target --json
npm run acceptance -- project validate sample-cli-project --json
npm run acceptance -- contract validate C:\path\to\target\.acceptance\contracts\TASK-001.yaml --json
```

Submit only a resolved Git commit. The same project, task, commit, and contract content hash returns the existing run instead of creating a duplicate.
