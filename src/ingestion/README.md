# Real-Time Data Ingestion Layer

This directory defines the source-agnostic boundary for live streetlight data.

## Design

External sources (GVMC CCMS, future IoT gateways, field systems, or the demo simulator) must enter through an adapter and emit a canonical event. Adapters must never update dashboard state directly.

```text
External Source
      |
      v
 Source Adapter
      |
      v
 Canonical Event
      |
      v
 Validation / Authentication
      |
      v
 Asset Resolution
      |
      v
 Event Processing
      |
      +----> Persistence
      |
      +----> Incident / Workflows
      |
      +----> WebSocket / Notifications
      |
      v
 Dashboard
```

## Canonical event requirements

Every telemetry/event payload must preserve:

- `source` — where the observation came from (`CCMS`, `IOT`, `FIELD`, `CITIZEN`, `SYSTEM`, etc.)
- `source_device_id` — identifier supplied by the external source
- `asset_id` — canonical platform asset identifier when resolved
- `observed_at` — when the source observed the condition
- `received_at` — when the platform received it
- `event_type` — telemetry/fault/state/heartbeat/etc.
- `data` — normalized measurements or event attributes
- `quality` — freshness/validity information

## Demo now, GVMC later

The first adapter can be a simulator that sends data through the same ingestion contract as a real CCMS. When GVMC provides a CCMS API/protocol, only the source adapter and asset-ID mapping need to change; downstream incident, SLA, dashboard, audit, and intelligence logic should remain unchanged.
