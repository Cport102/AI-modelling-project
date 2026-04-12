const assert = require('node:assert/strict');

const {
  MODEL_CONSTANTS,
  normalizeExtractedProfile,
  calculateReturns,
} = require('../returns-model-v2');

function buildSampleExtraction() {
  return {
    structured: {
      company_name: 'Atlas Industrial Services',
      source_table_name: 'Financial Summary',
      currency: 'USD',
      units: 'millions',
      assumptions: [],
      warnings: [],
      historical_years: [
        {
          period_label: '2024A',
          revenue: 92,
          gross_profit: 35,
          ebitda: 17,
          source_page: 12,
          confidence: 0.95,
          notes: null,
        },
        {
          period_label: '2025A',
          revenue: 100,
          gross_profit: 39,
          ebitda: 20,
          source_page: 12,
          confidence: 0.97,
          notes: null,
        },
      ],
      forecast_years: [
        {
          period_label: 'FY25F',
          revenue: 105,
          gross_profit: 41,
          ebitda: 22,
          source_page: 13,
          confidence: 0.91,
          notes: null,
        },
        {
          period_label: 'FY26E',
          revenue: 110,
          gross_profit: 43,
          ebitda: 25,
          source_page: 13,
          confidence: 0.9,
          notes: null,
        },
        {
          period_label: 'FY27E',
          revenue: 118,
          gross_profit: 46,
          ebitda: 28,
          source_page: 13,
          confidence: 0.88,
          notes: null,
        },
        {
          period_label: 'FY28E',
          revenue: 126,
          gross_profit: 49,
          ebitda: 31,
          source_page: 13,
          confidence: 0.87,
          notes: null,
        },
        {
          period_label: 'FY29E',
          revenue: 134,
          gross_profit: 52,
          ebitda: 34,
          source_page: 13,
          confidence: 0.86,
          notes: null,
        },
      ],
    },
  };
}

function nearlyEqual(actual, expected, tolerance = 0.01) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `Expected ${actual} to be within ${tolerance} of ${expected}`);
}

function run(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
  }
}

run('normalizeExtractedProfile derives LTM/NTM values in absolute units', () => {
  const normalized = normalizeExtractedProfile(buildSampleExtraction());

  assert.equal(normalized.companyName, 'Atlas Industrial Services');
  assert.equal(normalized.currency, 'USD');
  assert.equal(normalized.sourceUnits, 'millions');
  assert.equal(normalized.unitMultiplier, 1000000);
  assert.equal(normalized.ltmRevenue, 100000000);
  assert.equal(normalized.ltmEbitda, 20000000);
  assert.equal(normalized.ntmRevenue, 105000000);
  assert.equal(normalized.ntmEbitda, 22000000);
});

run('fixed constants apply even when legacy inputs are still present', () => {
  const result = calculateReturns(buildSampleExtraction(), {
    entryDate: '2026-01-01',
    fiscalYearEndMonth: 6,
    entryMultiple: 8,
    exitMultiple: 9,
    leverage: 4.5,
    holdYears: 3,
    pretaxUfcfConversion: 50,
    interestRate: 99,
    taxRate: 1,
    advisoryFeesPct: 99,
    financingFeesPct: 99,
    mipPct: 99,
    ebitdaGrowthRate: 50,
    ebitdaMarginRate: 50,
    capexPct: 10,
    nwcPct: 10,
  });

  assert.deepEqual(result.validation.errors, []);
  assert.equal(result.assumptions.interestRate, MODEL_CONSTANTS.interestRate);
  assert.equal(result.assumptions.taxRate, MODEL_CONSTANTS.taxRate);
  assert.equal(result.assumptions.advisoryFeesPct, MODEL_CONSTANTS.advisoryFeesPct);
  assert.equal(result.assumptions.financingFeesPct, MODEL_CONSTANTS.financingFeesPct);
  assert.equal(result.assumptions.mipPct, MODEL_CONSTANTS.mipPct);
});

run('entry calculations use fixed 1 percent advisory fees and 2 percent financing fees', () => {
  const result = calculateReturns(buildSampleExtraction(), {
    entryDate: '2026-01-01',
    fiscalYearEndMonth: 6,
    entryMultiple: 8,
    exitMultiple: 9,
    leverage: 4.5,
    holdYears: 3,
    pretaxUfcfConversion: 50,
  });

  assert.equal(result.entry.ntmPeriodLabel, 'FY26E / FY27E');
  nearlyEqual(result.entry.ntmEbitda, 26500000);
  nearlyEqual(result.entry.entryEv, 212000000);
  nearlyEqual(result.entry.debt, 90000000);
  nearlyEqual(result.entry.advisoryFees, 2120000);
  nearlyEqual(result.entry.financingFees, 1800000);
  nearlyEqual(result.entry.minimumCash, 6666666.67);
});

run('minimum cash entered in source units increases sponsor equity', () => {
  const baseline = calculateReturns(buildSampleExtraction(), {
    entryDate: '2026-01-01',
    fiscalYearEndMonth: 6,
    entryMultiple: 8,
    exitMultiple: 9,
    leverage: 4.5,
    holdYears: 3,
    pretaxUfcfConversion: 50,
  });

  const withMinimumCash = calculateReturns(buildSampleExtraction(), {
    entryDate: '2026-01-01',
    fiscalYearEndMonth: 6,
    entryMultiple: 8,
    exitMultiple: 9,
    leverage: 4.5,
    minimumCashInSourceUnits: 10,
    holdYears: 3,
    pretaxUfcfConversion: 50,
  });

  nearlyEqual(withMinimumCash.entry.minimumCash, 10000000);
  nearlyEqual(withMinimumCash.entry.pfEquity - baseline.entry.pfEquity, 3333333.33, 0.1);
});

run('tax is always 30 percent of EBIT and interest is always 10 percent of debt', () => {
  const result = calculateReturns(buildSampleExtraction(), {
    entryDate: '2026-01-01',
    fiscalYearEndMonth: 6,
    entryMultiple: 8,
    exitMultiple: 9,
    leverage: 4.5,
    holdYears: 2,
    pretaxUfcfConversion: 50,
  });

  nearlyEqual(result.operatingProjection[0].interest, 9000000);
  nearlyEqual(result.operatingProjection[0].capex, 6250000);
  nearlyEqual(result.operatingProjection[0].ebit, 18750000);
  nearlyEqual(result.operatingProjection[0].pretaxUfcf, 12500000);
  nearlyEqual(result.operatingProjection[0].tax, 5625000);
});

run('year 1 end-of-period cash only accrues the stub-period share of post-tax cash flow', () => {
  const result = calculateReturns(buildSampleExtraction(), {
    entryDate: '2026-01-01',
    fiscalYearEndMonth: 6,
    entryMultiple: 8,
    exitMultiple: 9,
    leverage: 4.5,
    holdYears: 2,
    pretaxUfcfConversion: 50,
  });

  nearlyEqual(result.operatingProjection[0].cashAccrualFactor, 0.5, 0.00001);
  nearlyEqual(result.operatingProjection[0].realizedPostTaxCashFlow, -1062500);
  nearlyEqual(result.operatingProjection[0].cashEop, result.entry.minimumCash - 1062500, 0.1);
  assert.ok(result.validation.warnings.includes('Year 1 end-of-period cash reflects 6/12 of post-tax cash flow based on the entry date.'));
});

run('MIP is calculated as 10 percent of gross capital gain', () => {
  const result = calculateReturns(buildSampleExtraction(), {
    entryDate: '2026-01-01',
    fiscalYearEndMonth: 6,
    entryMultiple: 8,
    exitMultiple: 9,
    leverage: 4.5,
    holdYears: 3,
    pretaxUfcfConversion: 50,
  });

  nearlyEqual(result.exit.grossCapitalGain, result.exit.exitEquityBeforeMip - result.entry.pfEquity);
  nearlyEqual(result.exit.mip, -0.1 * result.exit.grossCapitalGain);
  nearlyEqual(result.exit.pfEquityExit, result.exit.exitEquityBeforeMip + result.exit.mip);
});

run('entry EV uses blended NTM EBITDA for the selected fiscal year end', () => {
  const result = calculateReturns(buildSampleExtraction(), {
    entryDate: '2026-01-01',
    fiscalYearEndMonth: 6,
    entryMultiple: 8,
    exitMultiple: 9,
    leverage: 4.5,
    holdYears: 2,
    pretaxUfcfConversion: 50,
  });

  nearlyEqual(result.entry.ntmRevenue, 114000000);
  nearlyEqual(result.entry.ntmEbitda, 26500000);
  nearlyEqual(result.entry.entryEv, 212000000);
  assert.deepEqual(result.entry.ntmBlendBreakdown.map(item => [item.periodLabel, item.months]), [['FY26E', 6], ['FY27E', 6]]);
});

run('true NTM EBITDA blend changes with the entry date within the fiscal year', () => {
  const result = calculateReturns(buildSampleExtraction(), {
    entryDate: '2026-04-01',
    fiscalYearEndMonth: 6,
    entryMultiple: 8,
    exitMultiple: 9,
    leverage: 4.5,
    holdYears: 2,
    pretaxUfcfConversion: 50,
  });

  nearlyEqual(result.entry.ntmEbitda, 27250000);
  assert.deepEqual(result.entry.ntmBlendBreakdown.map(item => [item.periodLabel, item.months]), [['FY26E', 3], ['FY27E', 9]]);
});

run('EBITDA is sourced from CIM forecast data when available', () => {
  const result = calculateReturns(buildSampleExtraction(), {
    entryDate: '2026-01-01',
    fiscalYearEndMonth: 6,
    entryMultiple: 8,
    exitMultiple: 9,
    leverage: 4.5,
    holdYears: 2,
    pretaxUfcfConversion: 50,
  });

  assert.equal(result.operatingProjection[0].periodLabel, 'FY26E');
  nearlyEqual(result.operatingProjection[0].ebitda, 25000000);
  nearlyEqual(result.operatingProjection[1].ebitda, 28000000);
  nearlyEqual(result.operatingProjection[0].ebitdaMargin, 25000000 / 110000000, 0.00001);
});

run('removed fields are no longer required by validation and pretax UFCF conversion drives cash flow', () => {
  const result = calculateReturns(buildSampleExtraction(), {
    entryDate: '2026-01-01',
    fiscalYearEndMonth: 6,
    entryMultiple: 8,
    exitMultiple: 9,
    leverage: 4.5,
    holdYears: 3,
    pretaxUfcfConversion: 60,
  });

  assert.deepEqual(result.validation.errors, []);
  assert.equal(result.assumptions.pretaxUfcfConversionRates.length, 3);
  nearlyEqual(result.operatingProjection[0].pretaxUfcf, 15000000);
  nearlyEqual(result.operatingProjection[1].pretaxUfcf, 16800000);
});

run('exit multiple uses the forward year and extrapolates beyond the CIM forecast', () => {
  const result = calculateReturns(buildSampleExtraction(), {
    entryDate: '2026-01-01',
    fiscalYearEndMonth: 6,
    entryMultiple: 8,
    exitMultiple: 9,
    leverage: 4.5,
    holdYears: 5,
    pretaxUfcfConversion: 50,
  });

  assert.equal(result.operatingProjection[4].periodLabel, 'FY30E');
  assert.equal(result.exit.exitForwardPeriodLabel, 'FY31E');
  nearlyEqual(result.operatingProjection[4].revenue, 145652173.91, 0.1);
  nearlyEqual(result.exit.finalYearEbitda, 40.17007798 * 1000000, 100);
  assert.ok(result.validation.warnings.some(message => message.includes('Fiscal year 2030 was extrapolated')));
  assert.ok(result.validation.warnings.some(message => message.includes('Fiscal year 2031 was extrapolated')));
});

run('value creation bridge reconciles entry equity to exit equity within rounding tolerance', () => {
  const result = calculateReturns(buildSampleExtraction(), {
    entryDate: '2026-01-01',
    fiscalYearEndMonth: 6,
    entryMultiple: 8,
    exitMultiple: 9,
    leverage: 4.5,
    holdYears: 5,
    pretaxUfcfConversion: 50,
  });

  const bridge = result.valueCreationBridge;
  assert.ok(bridge);
  assert.ok(Array.isArray(bridge.steps));

  const entryStep = bridge.steps.find(step => step.key === 'entryEquity');
  const exitStep = bridge.steps.find(step => step.key === 'exitEquity');
  const deltaSum = bridge.steps
    .filter(step => step.type === 'delta')
    .reduce((sum, step) => sum + step.value, 0);

  nearlyEqual(entryStep.value + deltaSum, exitStep.value, 1.0);
});

run('non-positive LTM EBITDA floors debt and default minimum cash at zero', () => {
  const extraction = buildSampleExtraction();
  extraction.structured.historical_years[1].ebitda = -5;

  const result = calculateReturns(extraction, {
    entryDate: '2026-01-01',
    fiscalYearEndMonth: 6,
    entryMultiple: 8,
    exitMultiple: 8,
    leverage: 4,
    holdYears: 5,
    pretaxUfcfConversion: 50,
  });

  assert.deepEqual(result.validation.errors, []);
  nearlyEqual(result.entry.debt, 0);
  nearlyEqual(result.entry.minimumCash, 0);
  assert.ok(result.validation.warnings.includes('LTM EBITDA is non-positive. Entry debt and default minimum cash will be floored at zero.'));
});

run('missing forecast years required for blended NTM EBITDA fail validation clearly', () => {
  const extraction = buildSampleExtraction();
  extraction.structured.forecast_years = extraction.structured.forecast_years.filter(row => row.period_label !== 'FY27E');

  const result = calculateReturns(extraction, {
    entryDate: '2026-01-01',
    fiscalYearEndMonth: 6,
    entryMultiple: 8,
    exitMultiple: 9,
    leverage: 4.5,
    holdYears: 3,
    pretaxUfcfConversion: 50,
  });

  assert.ok(result.validation.errors.includes('NTM EBITDA is missing from the extracted CIM profile for the selected entry date and fiscal year end.'));
  assert.ok(result.validation.warnings.includes('A CIM forecast EBITDA value is required for fiscal year 2027 to calculate blended NTM EBITDA.'));
});

if (process.exitCode) {
  process.exit(process.exitCode);
}
