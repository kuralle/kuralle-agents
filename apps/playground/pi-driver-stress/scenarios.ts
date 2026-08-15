export interface StressExpectation {
  flows?: string[];
  tools?: string[];
  answerIncludes?: string[];
  requireHandoff?: boolean;
  requireParallelTools?: string[];
}

export interface StressScenario {
  id: string;
  source: string;
  prompts: string[];
  expectation: StressExpectation;
}

const flowSource = (name: string): string =>
  `packages/core/examples/flows/${name}.ts`;

export const CORE_FLOW_SCENARIOS: StressScenario[] = [
  {
    id: 'dynamic-registration',
    source: flowSource('dynamic-registration'),
    prompts: ['Please start a refund'],
    expectation: { flows: ['refund'], tools: ['enter_flow'] },
  },
  {
    id: 'rehydrate-definition',
    source: flowSource('rehydrate-definition'),
    prompts: ['I want to check my order eligibility for account acc-1.'],
    expectation: { flows: ['eligibility'] },
  },
  {
    id: 'flow-builder',
    source: flowSource('flow-builder'),
    prompts: [
      'build a refund-eligibility flow that collects an account id, checks eligibility with the lookup tool, and replies with the verdict',
    ],
    expectation: { tools: ['list_available_tools', 'save_flow'] },
  },
  {
    id: 'extraction-node-demo',
    source: flowSource('extraction-node-demo'),
    prompts: [
      'My name is Sarah Chen, my phone is 555-0123, and I need a follow-up for my knee.',
      'Yes, everything is correct.',
    ],
    expectation: { flows: ['intake'] },
  },
  {
    id: 'food-ordering-direct-functions',
    source: flowSource('food-ordering-direct-functions'),
    prompts: ['I want sushi.', 'Two spicy tuna rolls.', 'Looks good.'],
    expectation: { flows: ['order'], tools: ['choose_sushi', 'select_sushi_order'] },
  },
  {
    id: 'food-ordering',
    source: flowSource('food-ordering'),
    prompts: ['I want pizza.', 'A large pepperoni pizza.', 'That order is correct.'],
    expectation: { flows: ['order'], tools: ['choose_pizza', 'select_pizza_order'] },
  },
  {
    id: 'insurance-claims-adversarial',
    source: flowSource('insurance-claims-adversarial'),
    prompts: [
      'I need to file an auto insurance claim for a car accident. Start the claim intake now.',
      'Policy POL-123456, John Smith, phone 5551234567.',
      'It happened 2025-03-15 at Main Street. A truck hit my driver side door.',
      'It is a 2022 Toyota Camry, plate ABC-1234, with the driver door caved in.',
      'Yes, all claim details are correct.',
    ],
    expectation: { flows: ['claims-intake'], tools: ['submit_claim'], answerIncludes: ['CLM-'] },
  },
  {
    id: 'insurance-quote',
    source: flowSource('insurance-quote'),
    prompts: ['I need a quote.', 'I am 28.', 'Married.', 'The quote looks good; end it.'],
    expectation: { flows: ['quote'], tools: ['calculate_quote', 'end_quote'] },
  },
  {
    id: 'kuralle-sink-spike',
    source: flowSource('kuralle-sink-spike'),
    prompts: ['Book an appointment for Sarah on 2026-08-04 at 10:00 AM. Use the booking tool now.'],
    expectation: { flows: ['booking'], tools: ['book_appointment'] },
  },
  {
    id: 'llm-switching',
    source: flowSource('llm-switching'),
    prompts: ['Please switch to Google.', 'Use get_current_weather now for San Francisco in fahrenheit and report its result.'],
    expectation: { tools: ['switch_llm', 'get_current_weather'], requireHandoff: true },
  },
  {
    id: 'model-matrix-benchmark',
    source: flowSource('model-matrix-benchmark'),
    prompts: ['My name is Alex Martinez.', 'I need to reschedule my appointment.'],
    expectation: { flows: ['intake'] },
  },
  {
    id: 'model-shootout',
    source: flowSource('model-shootout'),
    prompts: [
      'I need to file an auto insurance claim. I got into a car accident this morning; start the claim intake now.',
      'My policy number is POL-123456, name is John Smith, phone 5551234567.',
      'It happened on 2025-03-15 around 8:30 AM at the intersection of Main St and 5th Ave. A truck ran a red light and hit my driver side door.',
      'It is a 2022 Toyota Camry, plate ABC-1234. The entire driver side door is caved in and the side mirror is gone.',
      'Yes, all listed claim details are correct. Call confirm_claim and submit it now.',
    ],
    expectation: { flows: ['claims-intake'], tools: ['submit_claim'] },
  },
  {
    id: 'openrouter-benchmark',
    source: flowSource('openrouter-benchmark'),
    prompts: ['My name is Alex Martinez.', 'I need to reschedule my appointment.'],
    expectation: { flows: ['intake'] },
  },
  {
    id: 'patient-intake',
    source: flowSource('patient-intake'),
    prompts: [
      'My birthday is 1983-01-01.',
      'I take Lisinopril 10mg.',
      'I am allergic to penicillin.',
      'I have type 2 diabetes.',
      'I am here for an annual physical.',
      'Yes, everything is correct.',
    ],
    expectation: { flows: ['intake'], tools: ['verify_birthday', 'record_visit_reasons'] },
  },
  {
    id: 'podcast-interview',
    source: flowSource('podcast-interview'),
    prompts: [
      'Please start the podcast interview. I am Sam, a product designer focused on creative tooling.',
      'I want to discuss designing delightful AI interfaces.',
      'Onboarding should reduce friction. Move to the next aspect.',
      'Transparent controls build trust. Move to the next aspect.',
      'Speed and craft must stay balanced. Please wrap up.',
      'Keep listening to users. End the interview.',
    ],
    expectation: {
      flows: ['interview'],
      tools: ['proceed_to_topic', 'start_interview', 'next_question', 'wrap_up', 'end_interview'],
    },
  },
  {
    id: 'quickstart-hello-world',
    source: flowSource('quickstart-hello-world'),
    prompts: ['Hi!', 'My favorite color is blue.'],
    expectation: { flows: ['hello'], tools: ['submit_initial_data'] },
  },
  {
    id: 'restaurant-reservation-direct-functions',
    source: flowSource('restaurant-reservation-direct-functions'),
    prompts: ['Hello, I need a reservation.', '2 people.', '8:00 PM.', 'Try 9:00 PM.', 'That is all.'],
    expectation: { flows: ['reservation'], tools: ['collect_party_size', 'check_availability'] },
  },
  {
    id: 'restaurant-reservation',
    source: flowSource('restaurant-reservation'),
    prompts: ['Hi, I need a reservation.', 'Party of 4.', '7:00 PM.', 'Try 6:00 PM.', 'That works, thanks.'],
    expectation: { flows: ['reservation'], tools: ['collect_party_size', 'check_availability'] },
  },
  {
    id: 'routing-mode-ttft-smoke',
    source: flowSource('routing-mode-ttft-smoke'),
    prompts: ['I would like to book an appointment with an advisor.'],
    expectation: { flows: ['book-advisor-appointment'], tools: ['enter_flow'] },
  },
  {
    id: 'routing-model-benchmark',
    source: flowSource('routing-model-benchmark'),
    prompts: ['My name is Alex Martinez.', 'I need to reschedule my appointment.'],
    expectation: { flows: ['intake'] },
  },
  {
    id: 'warm-transfer',
    source: flowSource('warm-transfer'),
    prompts: [
      'Tell me the store location and hours.',
      'Now I want to place an order.',
      'I can hold; the human agent has joined.',
      'Agent here. I am ready to connect.',
    ],
    expectation: {
      flows: ['transfer'],
      tools: ['check_store_location_and_hours_of_operation', 'start_order'],
    },
  },
];

export const SUBSTRATE_SCENARIOS: StressScenario[] = [
  {
    id: 'kitchen-sink',
    source: 'apps/playground/pi-driver-stress/kitchenSink.ts',
    prompts: [
      'Run the complete operations check exactly as instructed, using every evidence and parallel lookup tool before answering.',
    ],
    expectation: {
      flows: ['operations-check'],
      tools: [
        'load_skill',
        'read_skill_resource',
        'workspace',
        'lookup_inventory',
        'quote_shipping',
        'calculate_tax',
      ],
      answerIncludes: ['ap-south-1', 'ORBIT-7', 'in stock', '$7.99', '$12.50'],
      requireParallelTools: ['lookup_inventory', 'quote_shipping', 'calculate_tax'],
    },
  },
  {
    id: 'okf',
    source: 'apps/playground/pi-driver-stress/kitchenSink.ts',
    prompts: [
      'How do I compute weekly active users, and which table and identity column does it use?',
    ],
    expectation: {
      flows: ['okf-navigation'],
      tools: ['load_skill', 'workspace'],
      answerIncludes: ['events', 'user_id', 'distinct'],
    },
  },
];

export const ALL_SCENARIOS = [...CORE_FLOW_SCENARIOS, ...SUBSTRATE_SCENARIOS];
