import { describe, expect, it } from 'vitest';
import {
  buildPresentation,
  confidenceBandOf,
  isFitToPublish,
  participationStatus,
} from './build-presentation';
import { decisionFor } from './presentation.config';

describe('confidence bands (client: <10 very low, >=10 medium, >= required sample strong)', () => {
  it.each([
    [0, 81, 'VERY_LOW'],
    [9, 81, 'VERY_LOW'],
    [10, 81, 'MEDIUM'],
    [80, 81, 'MEDIUM'],
    [81, 81, 'STRONG'],
    [500, 81, 'STRONG'],
    [50, null, 'MEDIUM'],
  ] as const)('%d valid of %s required is %s', (valid, required, band) => {
    expect(confidenceBandOf(valid, required)).toBe(band);
  });

  it('is fit to publish only when strong', () => {
    expect(isFitToPublish('STRONG')).toBe(true);
    expect(isFitToPublish('MEDIUM')).toBe(false);
    expect(isFitToPublish('VERY_LOW')).toBe(false);
  });
});

describe('village participation status', () => {
  it('flags one village holding every response as fully concentrated', () => {
    expect(participationStatus(100, 1)).toBe('FULLY_CONCENTRATED');
    expect(participationStatus(75, 2)).toBe('CONCENTRATED');
    expect(participationStatus(40, 3)).toBeNull();
  });
});

describe('decision rule', () => {
  it('asks for more data while confidence is very low, whatever the severity', () => {
    expect(decisionFor('VERY_LOW', 'CRITICAL')).toBe('collectMore');
    expect(decisionFor('MEDIUM', 'HIGH')).toBe('confirmThenAct');
    expect(decisionFor('STRONG', 'CRITICAL')).toBe('prioritise');
    expect(decisionFor('STRONG', 'LOW')).toBe('monitor');
  });
});

describe('buildPresentation', () => {
  const surveyReport = {
    responseQuality: {
      validResponses: 5,
      submittedResponses: 6,
      requiredSampleSize: 81,
      population: 500,
    },
    severity: {
      overallVillageNeedsIndex: 57.75,
      label: 'HIGH',
      domains: [
        { name: 'Education', severityScore: 38 },
        { name: 'Social Development', severityScore: 77.5 },
      ],
    },
    priorityNeeds: {
      needs: [
        {
          kpiName: 'Perceived personal safety',
          severityScore: 80,
          gapType: 'structural',
          validResponseCount: 5,
        },
        {
          kpiName: 'Access to social protection',
          severityScore: 75,
          gapType: 'acute',
          validResponseCount: 5,
        },
      ],
    },
    coverage: { responsesExcluded: 1, duplicateResponses: 0, lowConfidenceResponses: 0 },
    aiSummary: { executiveSummary: '…' },
    demographics: { gender: [] },
    dataQualityNote: '…',
  };

  it("derives the mockup's blocks from a survey report", () => {
    const p = buildPresentation('RPT14', surveyReport, {
      participation: [
        {
          governorate: 'Ad-Dawadmi',
          total: 5,
          rows: [{ village: 'Al Aham', responses: 5, sharePct: 100, status: 'FULLY_CONCENTRATED' }],
        },
      ],
      reviewerName: 'Reviewer',
      reviewerRole: 'Human Reviewer',
      organization: 'Amina Foundation',
    });
    // Blocks are switched off for the current reports (client, 15 Oct 2026).
    expect(p.blocks).toEqual([]);
    expect(p.confidence?.band).toBe('VERY_LOW');
    expect(p.summary?.topDomain).toEqual({ name: 'Social Development', score: 77.5 });
    expect(p.summary?.topKpis.map((k) => k.name)).toEqual([
      'Perceived personal safety',
      'Access to social protection',
    ]);
    expect(p.summary?.decision).toBe('collectMore');
    expect(p.kpis?.[0]).toMatchObject({
      gapType: 'structural',
      band: 'VERY_LOW',
      fitToPublish: false,
    });
    expect(p.excluded).toEqual({ total: 1, duplicate: 0, lowConfidence: 0, other: 1 });
    expect(p.collapsed).toEqual([]);
  });

  it("uses the study's figures when the report carries no response-quality block", () => {
    const p = buildPresentation(
      'RPT06',
      { regions: [{ regionName: 'Riyadh', governorate: 'Ad-Diriyah', severityScore: 44.35 }] },
      {
        responseQuality: {
          validResponses: 12,
          submittedResponses: 12,
          requiredSampleSize: 81,
          population: 500,
        },
      },
    );
    expect(p.confidence?.band).toBe('MEDIUM');
    expect(p.summary?.topArea).toEqual({ name: 'Ad-Diriyah', score: 44.35 });
    expect(p.blocks).toEqual([]);
    expect(p.blocks).not.toContain('kpis');
  });

  it('leaves out what a report has no data for, and the sharing log entirely', () => {
    expect(buildPresentation('RPT10', {}).blocks).toEqual([]);
    expect(buildPresentation('RPT12', surveyReport).blocks).toEqual([]);
  });
});
