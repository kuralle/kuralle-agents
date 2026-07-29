import { describe, expect, test } from 'bun:test';
import { createInsuranceClaimsFlow } from '../../examples/_shared/insuranceClaimsFlow.js';

describe('insurance claims example', () => {
  test('projects each collect result into flow state before downstream actions', async () => {
    const flow = createInsuranceClaimsFlow();
    const collectIds = [
      'collect_policy',
      'collect_incident',
      'collect_vehicle',
      'collect_property',
    ];

    for (const id of collectIds) {
      const node = flow.nodes.find((candidate) => candidate.id === id);
      if (node?.kind !== 'collect') throw new Error(`missing collect node ${id}`);
      const data = { marker: id };
      const transition = await node.onComplete(data, {});
      expect(transition).toMatchObject({ data });
    }
  });

  test('non-required incident time and property estimate are schema-optional', async () => {
    const flow = createInsuranceClaimsFlow();
    const incident = flow.nodes.find((node) => node.id === 'collect_incident');
    const property = flow.nodes.find((node) => node.id === 'collect_property');
    if (incident?.kind !== 'collect' || property?.kind !== 'collect') throw new Error('missing nodes');

    const incidentResult = await incident.schema['~standard'].validate({
      incidentDate: '2025-03-15',
      incidentLocation: 'Main Street',
      description: 'A truck hit the driver side door.',
    });
    const propertyResult = await property.schema['~standard'].validate({
      propertyAddress: '1 Main Street',
      propertyType: 'house',
      damageType: 'storm',
      damageDescription: 'The roof was damaged by wind.',
    });
    expect('issues' in incidentResult).toBeFalse();
    expect('issues' in propertyResult).toBeFalse();
  });
});
