# Smoke Test Checklist

Use this checklist after merging to `master` to verify the integration end to end.

## Prerequisites

- Fresh install or clean local environment
- `CLICKUP_API_TOKEN` set to a valid token with access to the target ClickUp workspace/list/task
- A known target workspace, list, or task to exercise
- If testing websocket transport, `OPENCLAW_WORKBOARD_WS_URL` set to a reachable WebSocket endpoint
- If testing webhook/event delivery, the bridge must be reachable from ClickUp or your test source
- `CLICKUP_BASE_URL` only if you are pointing at a non-default ClickUp API endpoint

## Happy Path

- Start the app or connector without errors
- Complete authentication / connection setup
- Trigger the primary action once
- Confirm the action appears in the target system
- Confirm the local app receives the expected success response
- Refresh or re-open the target item and verify state matches

## Update Flow

- Edit the synced object in the source system
- Confirm the change propagates correctly
- Verify no duplicate records are created
- Confirm timestamps / status / metadata update as expected

## Delete / Unlink Flow

- Remove or unlink the synced object
- Confirm the target system reflects the deletion or unlink state
- Confirm the app handles missing items gracefully

## Failure Cases

- Try the flow with invalid credentials
- Try the flow with missing required fields
- Try the flow with a disconnected or unavailable endpoint
- Confirm errors are clear and actionable

## Pass Criteria

- Main flow works end to end
- Update flow works end to end
- Failure cases fail safely
- No unexpected console errors or crashes
- No duplicate records or silent data loss

## Notes

- Record any failing step, error message, and repro path here during testing.
