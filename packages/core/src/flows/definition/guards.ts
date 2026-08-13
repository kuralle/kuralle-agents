import type { ChoiceOption } from '../../types/selection.js';
import type { AuthoringFlowDefinition, AuthoringFlowNodeDefinition } from './authoring.js';
import { choiceOptionSchema } from './schema.js';
import type { ValidatableFlowDefinition, ValidatableFlowNodeDefinition } from './schema.js';
import type { FlowDefinition, FlowDefinitionNodeKind, FlowNodeDefinition } from './types.js';
import type { z } from 'zod';

type Extends<A, B> = [A] extends [B] ? true : never;
type Expect<T extends true> = T;

export type AuthoringUnion = AuthoringFlowNodeDefinition;
export type CanonicalUnion = FlowNodeDefinition;
export type ValidatableUnion = ValidatableFlowNodeDefinition;

const canonicalNodeFitsAuthoring: Expect<Extends<FlowNodeDefinition, AuthoringFlowNodeDefinition>> = true;
const validatableNodeFitsCanonical: Expect<Extends<ValidatableFlowNodeDefinition, FlowNodeDefinition>> = true;
const canonicalNodeFitsValidatable: Expect<Extends<FlowNodeDefinition, ValidatableFlowNodeDefinition>> = true;
const canonicalDefFitsAuthoring: Expect<Extends<FlowDefinition, AuthoringFlowDefinition>> = true;
const validatableDefFitsCanonical: Expect<Extends<ValidatableFlowDefinition, FlowDefinition>> = true;
const canonicalDefFitsValidatable: Expect<Extends<FlowDefinition, ValidatableFlowDefinition>> = true;
const nodeKindFitsCanonical: Expect<Extends<FlowNodeDefinition['kind'], FlowDefinitionNodeKind>> = true;
const nodeKindCovered: Expect<Extends<FlowDefinitionNodeKind, FlowNodeDefinition['kind']>> = true;

type ChoiceOptionWire = z.infer<typeof choiceOptionSchema>;
const choiceWireFitsCanonical: Expect<Extends<ChoiceOptionWire, ChoiceOption>> = true;
const choiceCanonicalFitsWire: Expect<Extends<ChoiceOption, ChoiceOptionWire>> = true;

void canonicalNodeFitsAuthoring;
void validatableNodeFitsCanonical;
void canonicalNodeFitsValidatable;
void canonicalDefFitsAuthoring;
void validatableDefFitsCanonical;
void canonicalDefFitsValidatable;
void nodeKindFitsCanonical;
void nodeKindCovered;
void choiceWireFitsCanonical;
void choiceCanonicalFitsWire;
