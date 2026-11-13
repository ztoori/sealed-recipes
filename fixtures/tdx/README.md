# TDX test vectors

`tdx_quote` and `tdx_quote_collateral.json` are the sample Intel TDX quote and its collateral from
[Phala-Network/dcap-qvl](https://github.com/Phala-Network/dcap-qvl) (`sample/`, Apache-2.0). Its collateral is valid
at 1751000000 (2025-06-27), the time dcap-qvl's own tests use; `tests/tdx.test.ts` verifies with it.

`dstack_attestation.json` is a real attestation of the live runner (`tee.sealedrecipes.testnet`, Intel TDX CVM on Phala
Cloud, 2026-11-13): TDX quote, dstack event log (runtime events sent without digests) and app-compose.json.
`tests/compose.test.ts` replays its RTMR3 and checks the measured compose hash against the compose file inside it.
