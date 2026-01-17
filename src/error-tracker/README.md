# Turret

- Built-in Observability Platform: errors, logs, session replays, spans, profiles logs, traces, metrics and errors.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Error Tracker Worker                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────────────────┐     ┌─────────────────────────────────┐   │
│  │      HTTP Interface         │     │      RPC Interface              │   │
│  │      (default export)       │     │   (ErrorTrackerRPC entrypoint)  │   │
│  │                             │     │                                 │   │
│  │  For: Browser/SPA SDKs      │     │  For: Server-side Workers       │   │
│  │  • CORS handling            │     │  • captureException(error, ctx) │   │
│  │  • API key authentication   │     │  • captureMessage(msg, level)   │   │
│  │  • Rate limiting            │     │  • captureEvent(event)          │   │
│  │  • Input validation         │     │                                 │   │
│  │  • Public endpoint          │     │  • Zero HTTP overhead           │   │
│  │                             │     │  • Type-safe                    │   │
│  │  POST /api/{id}/envelope/   │     │  • Private (same account only)  │   │
│  │  POST /api/{id}/store/      │     │  • Pass Error objects directly  │   │
│  └──────────────┬──────────────┘     └──────────────┬──────────────────┘   │
│                 │                                   │                       │
│                 └───────────────┬───────────────────┘                       │
│                                 ▼                                           │
│                    ┌────────────────────────┐                               │
│                    │   ErrorProcessor       │                               │
│                    │   (shared core logic)  │                               │
│                    └───────────┬────────────┘                               │
│                                │                                            │
│         ┌──────────────────────┼──────────────────────┐                     │
│         ▼                      ▼                      ▼                     │
│  ┌─────────────┐      ┌─────────────┐        ┌─────────────┐               │
│  │  Analytics  │      │     D1      │        │     R2      │               │
│  │   Engine    │      │  (issues)   │        │  (payloads) │               │
│  └─────────────┘      └─────────────┘        └─────────────┘               │
└─────────────────────────────────────────────────────────────────────────────┘
```
