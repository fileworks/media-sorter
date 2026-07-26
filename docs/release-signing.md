# Release signing

Signing enrollment and credentials are manual operator gates. The repository
contains no certificate, private key, account enrollment, legal agreement, or
secret value.

Release preflight has three outcomes:

- **Unsigned:** no platform signing variables exist. Packaging continues and
  emits `release-signing-state-<platform>.json` with `mode: unsigned`.
- **Signed:** the complete selected credential set exists. Nested and outer
  signing, trusted timestamping/notarization, and verification are mandatory;
  any failure blocks upload.
- **Partial:** at least one variable exists but the set is incomplete.
  Packaging stops before native payloads are built and reports only missing
  variable names.

## macOS Developer ID

Apple Developer Program membership normally costs **USD 99 per membership
year**, or local currency where available. Eligible nonprofit, educational, and
government entities can request a fee waiver. Re-check
[Apple's membership comparison](https://developer.apple.com/support/compare-memberships/)
and [fee-waiver rules](https://developer.apple.com/help/account/membership/fee-waivers)
before enrollment.

The operator must enroll, accept Apple's agreements, create a **Developer ID
Application** certificate, and create an app-specific password. Add these
encrypted repository secrets:

| Variable | Purpose |
|---|---|
| `APPLE_CERTIFICATE` | Base64-encoded Developer ID Application `.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | `.p12` import password |
| `APPLE_SIGNING_IDENTITY` | Exact `Developer ID Application: …` identity |
| `APPLE_ID` | Apple account used by `notarytool` |
| `APPLE_PASSWORD` | App-specific password |
| `APPLE_TEAM_ID` | Apple Developer team identifier |

CI imports the identity into an ephemeral keychain. Executable modes are
finalized first; nested Mach-O backend, ffmpeg/ffprobe, and native libraries are
signed inside-out with hardened runtime; Tauri signs the outer app using the
tracked entitlements; the final DMG is signed, submitted with `notarytool`,
stapled, and verified with `codesign`, `stapler`, and Gatekeeper. A payload
snapshot fails the job if content or executable modes change after nested
signing.

## Windows providers

The same no-shell JSON argument contract supports three provider selections:

| `WINDOWS_SIGNING_PROVIDER` | Enrollment and required variables |
|---|---|
| `microsoft-artifact-signing` | Microsoft Artifact Signing account, completed identity validation, profile and signer role; `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_CODE_SIGNING_ENDPOINT`, `AZURE_CODE_SIGNING_ACCOUNT`, `AZURE_CODE_SIGNING_PROFILE` |
| `signpath-oss` | Approved SignPath Foundation open-source project; `SIGNPATH_API_TOKEN`, `SIGNPATH_ORGANIZATION_ID`, `SIGNPATH_PROJECT_SLUG`, `SIGNPATH_SIGNING_POLICY_SLUG` |
| `ca-backed` | Conventional public code-signing certificate; `WINDOWS_CERTIFICATE_BASE64`, `WINDOWS_CERTIFICATE_PASSWORD` |

Microsoft's **Artifact Signing Basic** tier is currently **USD 9.99/month for
up to 5,000 signatures**, where eligible. Public Trust currently has geographic
and paid-subscription eligibility limits; verify the current
[Microsoft pricing](https://learn.microsoft.com/azure/artifact-signing/how-to-change-sku),
[eligibility FAQ](https://learn.microsoft.com/azure/artifact-signing/faq), and
[setup quickstart](https://learn.microsoft.com/azure/artifact-signing/quickstart)
before enrolling.

[SignPath Foundation](https://signpath.org/) offers free code signing for
approved open-source projects. Approval, project policy, and CI integration
remain external manual steps. If neither cloud option applies, use a
publicly-trusted CA-backed Authenticode certificate and follow that issuer's
current hardware-key or cloud-signing instructions.

All Windows providers also set:

| Variable | Contract |
|---|---|
| `WINDOWS_TIMESTAMP_URL` | Provider-approved RFC 3161/AuthentiCode trusted timestamp URL |
| `WINDOWS_SIGN_COMMAND_JSON` | Encrypted JSON argv array containing `{file}` and optionally `{timestamp_url}` / `{env:NAME}` placeholders |
| `WINDOWS_VERIFY_COMMAND_JSON` | Encrypted JSON argv array containing `{file}` and checking the signature, SHA-256 digest, and trusted timestamp |

The command runs directly without a shell and its arguments are never logged.
Provider tools must be installed or wrapped by the configured command according
to their official instructions. Tauri invokes the contract while building so
the shell embedded in MSI/NSIS is already signed; nested EXE/DLL payloads are
signed first, outer packages are verified again, and the portable ZIP is created
last from the signed shell and payload.

Never put commands containing real secret values in tracked files. Reference
them as `{env:VARIABLE_NAME}` and keep both command arrays in encrypted GitHub
secrets.
