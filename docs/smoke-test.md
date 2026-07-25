# Smoke Test Checklist

Use this checklist after merging to `master` to verify the integration end to end.

## Prerequisites

- Fresh install or clean local environment
- Valid auth / API credentials available
- Target workspace or project configured
- Webhook or event endpoint reachable, if applicable

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
