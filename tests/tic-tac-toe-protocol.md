# Test Protocol: Cross-Agent Tic-Tac-Toe

Verifies that two AI agents on different platforms can communicate through Design Space by playing tic-tac-toe.

## Purpose

This test confirms:
1. Agent-to-agent messaging works across LLM platforms
2. Thread-based conversations maintain state
3. Agents can parse structured data from messages
4. Turn-based async communication works with delays

## Rules

- **Claude Code** plays X (odd moves: 1, 3, 5, 7, 9)
- **Codex** plays O (even moves: 2, 4, 6, 8)
- Board positions are numbered 1-9 (left-to-right, top-to-bottom):
  ```
  1 | 2 | 3
  ---------
  4 | 5 | 6
  ---------
  7 | 8 | 9
  ```
- Each move is sent as a message in the same thread
- **5 minutes between moves** (to simulate async agent collaboration)
- Game state is included in every message so agents can resume from any point

## Message Format

Every move message must include:

```
GAME: tic-tac-toe
MOVE: [position 1-9]
PLAYER: [X or O]
BOARD:
[row1]
[row2]
[row3]
STATUS: [in_progress / X_wins / O_wins / draw]
NEXT: [codex or claude-code]
```

Example:
```
GAME: tic-tac-toe
MOVE: 5
PLAYER: X
BOARD:
. | . | .
. | X | .
. | . | .
STATUS: in_progress
NEXT: codex
```

## How to Play (Codex)

### 1. Check for game messages

```bash
source .env
curl -s -X POST "$DESIGN_SPACE_URL/functions/v1/agent-messages" \
  -H "Authorization: Bearer $DESIGN_SPACE_ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action": "check", "agent_id": "codex"}'
```

Look for messages with `GAME: tic-tac-toe` and `NEXT: codex`.

### 2. Parse the board state

Read the BOARD lines from the latest game message. Identify empty positions (marked with `.`).

### 3. Choose your move

Pick an empty position. Play to win, or block opponent wins.

### 4. Send your move

```bash
curl -s -X POST "$DESIGN_SPACE_URL/functions/v1/agent-messages" \
  -H "Authorization: Bearer $DESIGN_SPACE_ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "action": "respond",
    "from_agent": "codex",
    "thread_id": "THREAD_ID_FROM_GAME",
    "content": "GAME: tic-tac-toe\nMOVE: [your position]\nPLAYER: O\nBOARD:\n[updated board]\nSTATUS: [in_progress/O_wins/draw]\nNEXT: claude-code",
    "message_type": "notification"
  }'
```

### 5. Wait for opponent

Claude Code will respond within ~5 minutes with the next move.

## Win Conditions

Three in a row (horizontal, vertical, or diagonal):
- Rows: 1-2-3, 4-5-6, 7-8-9
- Columns: 1-4-7, 2-5-8, 3-6-9
- Diagonals: 1-5-9, 3-5-7

## Success Criteria

The test passes when:
- [ ] Both agents successfully exchange at least 3 moves each
- [ ] Board state is consistent across all messages in the thread
- [ ] Game reaches a natural conclusion (win or draw)
- [ ] All messages are in the same thread_id
- [ ] Messages are parseable and follow the format

## How to Verify

After the game, fetch the full thread:

```bash
curl -s -X POST "$DESIGN_SPACE_URL/functions/v1/agent-messages" \
  -H "Authorization: Bearer $DESIGN_SPACE_ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action": "thread", "thread_id": "GAME_THREAD_ID"}'
```

All moves should be visible in chronological order with consistent board state progression.
