# Production Checklist for flow agents

## Before Deploy

### Flow Architecture
- [ ] No duplicate tools (explicit + implicit doing same thing)
- [ ] All transitions have meaningful `on` values
- [ ] `autoRespond` is set correctly for each node
- [ ] Extraction schemas match expected data

### Prompts
- [ ] Triage prompt uses simple string (not PromptBuilder)
- [ ] Tool instructions are in the FIRST lines of the prompt
- [ ] Emergency criteria are explicit (IS vs IS NOT)
- [ ] Examples show correct tool calls

### Tool Calling
- [ ] Debug client shows `[tool-call]` events
- [ ] Debug client shows `[flow-transition]` events
- [ ] Test with vague input ("I need help")
- [ ] Test with specific input ("Book Dr. X")
- [ ] Test with edge cases (unavailable service, emergency)

### Error Handling
- [ ] Emergency node has clear instructions
- [ ] Human handoff has transcript
- [ ] Session timeout is configured
- [ ] Graceful degradation when tools fail

## Test Scenarios

### Scenario 1: Happy Path
1. User states intent clearly
2. Agent routes to correct node
3. Agent collects required data
4. Flow completes with success

### Scenario 2: Vague Input
1. User says something vague ("I need help")
2. Agent asks clarifying question OR routes to best guess
3. Agent does NOT immediately route to human
4. Agent does NOT call emergency

### Scenario 3: Unavailable Service
1. User asks for service not offered
2. Agent explains limitation
3. Agent offers alternatives
4. Agent does NOT hallucinate services

### Scenario 4: Emergency
1. User mentions true emergency ("not breathing")
2. Agent calls emergency tool
3. Agent provides ETU location and hotline
4. Agent offers to connect to emergency services

### Scenario 5: OPD/Walk-in
1. User asks about OPD
2. Agent explains it's walk-in
3. Agent provides hours and fee
4. Agent does NOT try to book OPD

## Monitoring

After deploy, monitor:
- Tool call success rate
- Transition completion rate
- Session abandonment rate
- Emergency trigger rate (should be low, but not zero)
- Human handoff rate

## Rollback Plan

If tool calling degrades:
1. Check prompt changes first
2. Check for new explicit tools that duplicate implicit
3. Check for prompt length increases
4. Simplify prompts and redeploy
