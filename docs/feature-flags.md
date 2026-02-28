# Feature Flags (Operational)

Use flags to reduce blast radius during deploys and incident response.

## Principles

- Prefer additive rollout: ship code behind a flag first.
- Keep an emergency kill switch for risky write paths.
- Define owner and removal date for every flag.

## Flag Classes

### Release flags

- Purpose: gradual rollout of new product behavior.
- Backing store: KV is acceptable when eventual consistency is okay.

### Ops kill switches

- Purpose: stop harmful writes quickly during incidents.
- Backing store: use strongly consistent controls where possible.
- Example: disable queue fan-out or expensive mutation paths.

### Access flags

- Purpose: early-access/beta cohorts.
- Scope: per-user or per-tenant.

## Rollout Checklist

1. Ship code path with old and new behavior.
2. Enable for internal users first.
3. Watch error rate, latency, and support signals.
4. Ramp traffic gradually.
5. Remove old path after stability window.

## Incident Checklist

1. Flip kill switch to stop impact.
2. Verify stabilization via health checks and logs.
3. Roll back compute if needed.
4. Restore traffic only after root cause is understood.
