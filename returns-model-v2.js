(function (root, factory) {
  const api = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }

  if (root) {
    root.ReturnsModel = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const UNIT_MULTIPLIERS = {
    ones: 1,
    thousands: 1000,
    millions: 1000000,
    billions: 1000000000,
  };

  const MODEL_CONSTANTS = Object.freeze({
    interestRate: 0.10,
    taxRate: 0.30,
    advisoryFeesPct: 0.01,
    financingFeesPct: 0.02,
    mipPct: 0.10,
  });

  function roundCurrency(value) {
    if (!Number.isFinite(value)) return null;
    return Math.round((value + Number.EPSILON) * 100) / 100;
  }

  function roundRatio(value) {
    if (!Number.isFinite(value)) return null;
    return Math.round((value + Number.EPSILON) * 1000000) / 1000000;
  }

  function pushUnique(list, message) {
    if (!Array.isArray(list) || !message) return;
    if (!list.includes(message)) {
      list.push(message);
    }
  }

  function isFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
  }

  function asArray(value) {
    if (value === undefined || value === null || value === '') return null;
    return Array.isArray(value) ? value.slice() : [value];
  }

  function toNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string') {
      const normalized = value.replace(/,/g, '').trim();
      if (!normalized) return null;
      const parsed = Number(normalized);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  }

  function normalizeRate(value, fieldName, warnings, options) {
    const parsed = toNumber(value);
    if (parsed === null) return null;

    if (options && options.allowNegative && parsed < 0) {
      return parsed >= -1 && parsed <= 1 ? parsed : parsed / 100;
    }

    if (Math.abs(parsed) >= 1 && Math.abs(parsed) <= 100) {
      warnings.push(`${fieldName} was interpreted as a percentage and divided by 100.`);
      return parsed / 100;
    }

    return parsed;
  }

  function clonePeriodRows(rows, type, multiplier) {
    const list = Array.isArray(rows) ? rows : [];

    return list.map(row => {
      const revenue = toNumber(row.revenue);
      const grossProfit = toNumber(row.gross_profit);
      const ebitda = toNumber(row.ebitda);

      return {
        periodLabel: row.period_label || '',
        fiscalYear: parseFiscalYear(row.period_label),
        type,
        revenue: revenue === null ? null : revenue * multiplier,
        grossProfit: grossProfit === null ? null : grossProfit * multiplier,
        ebitda: ebitda === null ? null : ebitda * multiplier,
        sourcePage: Number.isInteger(row.source_page) ? row.source_page : null,
        confidence: isFiniteNumber(row.confidence) ? row.confidence : null,
        notes: row.notes || null,
      };
    });
  }

  function getMultiplier(units, warnings) {
    if (!units) return 1;
    if (UNIT_MULTIPLIERS[units]) return UNIT_MULTIPLIERS[units];
    warnings.push(`Unrecognized units "${units}" were treated as ones.`);
    return 1;
  }

  function deriveMargin(revenue, ebitda) {
    if (!isFiniteNumber(revenue) || !isFiniteNumber(ebitda) || revenue === 0) return null;
    return roundRatio(ebitda / revenue);
  }

  function deriveGrossMargin(revenue, grossProfit) {
    if (!isFiniteNumber(revenue) || !isFiniteNumber(grossProfit) || revenue === 0) return null;
    return roundRatio(grossProfit / revenue);
  }

  function parseFiscalYear(periodLabel) {
    const text = String(periodLabel || '').trim();
    if (!text) return null;

    const fourDigitMatch = text.match(/(?:fy|fye|year)?\s*'?(\d{4})/i);
    if (fourDigitMatch) {
      return Number(fourDigitMatch[1]);
    }

    const twoDigitMatch = text.match(/(?:fy|fye|year)?\s*'?(\d{2})(?:[a-z]|$)/i);
    if (twoDigitMatch) {
      const year = Number(twoDigitMatch[1]);
      return year >= 70 ? 1900 + year : 2000 + year;
    }

    return null;
  }

  function addYears(date, years) {
    const result = new Date(date.getTime());
    result.setUTCFullYear(result.getUTCFullYear() + years);
    return result;
  }

  function addMonths(date, months) {
    const result = new Date(date.getTime());
    result.setUTCMonth(result.getUTCMonth() + months);
    return result;
  }

  function toUtcDate(value) {
    if (!value) return null;
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
      return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
    }

    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) return null;
      const isoDateMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (isoDateMatch) {
        const [, year, month, day] = isoDateMatch;
        return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
      }

      const parsed = new Date(trimmed);
      if (!Number.isNaN(parsed.getTime())) {
        return new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate()));
      }
    }

    return null;
  }

  function formatIsoDate(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
    return date.toISOString().slice(0, 10);
  }

  function deriveHistoricalRevenueGrowthRate(historicalRows) {
    const rows = (historicalRows || []).filter(row => isFiniteNumber(row.revenue) && row.revenue > 0);
    if (rows.length < 2) return null;

    const firstRevenue = rows[0].revenue;
    const lastRevenue = rows[rows.length - 1].revenue;
    const periods = rows.length - 1;
    if (!isFiniteNumber(firstRevenue) || !isFiniteNumber(lastRevenue) || firstRevenue <= 0 || lastRevenue <= 0 || periods <= 0) {
      return null;
    }

    return Math.pow(lastRevenue / firstRevenue, 1 / periods) - 1;
  }

  function deriveLatestRevenueGrowthRate(periodRows) {
    const rows = (periodRows || []).filter(row => isFiniteNumber(row.revenue) && row.revenue > 0);
    if (rows.length < 2) return null;

    const previousRevenue = rows[rows.length - 2].revenue;
    const latestRevenue = rows[rows.length - 1].revenue;
    if (!isFiniteNumber(previousRevenue) || !isFiniteNumber(latestRevenue) || previousRevenue <= 0 || latestRevenue <= 0) {
      return null;
    }

    return (latestRevenue / previousRevenue) - 1;
  }

  function deriveLatestKnownMargin(periodRows) {
    const rows = (periodRows || []).filter(row => isFiniteNumber(row.revenue) && row.revenue !== 0 && isFiniteNumber(row.ebitda));
    if (!rows.length) return null;
    const latestRow = rows[rows.length - 1];
    return deriveMargin(latestRow.revenue, latestRow.ebitda);
  }

  function deriveLatestKnownGrossMargin(periodRows) {
    const rows = (periodRows || []).filter(row => isFiniteNumber(row.revenue) && row.revenue !== 0 && isFiniteNumber(row.grossProfit));
    if (!rows.length) return null;
    const latestRow = rows[rows.length - 1];
    return deriveGrossMargin(latestRow.revenue, latestRow.grossProfit);
  }

  function getFiscalYearForDate(date, fiscalYearEndMonth) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
    const month = date.getUTCMonth() + 1;
    const year = date.getUTCFullYear();
    return month <= fiscalYearEndMonth ? year : year + 1;
  }

  function getEntryFiscalYear(entryDate, fiscalYearEndMonth) {
    return getFiscalYearForDate(entryDate, fiscalYearEndMonth);
  }

  function getNextTwelveMonthFiscalWeights(entryDate, fiscalYearEndMonth) {
    const weights = new Map();

    for (let monthOffset = 0; monthOffset < 12; monthOffset += 1) {
      const monthDate = addMonths(entryDate, monthOffset);
      const fiscalYear = getFiscalYearForDate(monthDate, fiscalYearEndMonth);
      weights.set(fiscalYear, (weights.get(fiscalYear) || 0) + 1);
    }

    return [...weights.entries()].map(([fiscalYear, months]) => ({
      fiscalYear,
      months,
      weight: months / 12,
    }));
  }

  function normalizeExtractedProfile(profile) {
    const warnings = [];
    const structured = profile && profile.structured ? profile.structured : profile || {};
    const units = structured.units || profile?.units || 'ones';
    const multiplier = getMultiplier(units, warnings);
    const historicalRows = clonePeriodRows(structured.historical_years || profile?.historical_years, 'Historical', multiplier);
    const forecastRows = clonePeriodRows(structured.forecast_years || profile?.forecast_years, 'Forecast', multiplier);
    const allKnownPeriods = historicalRows.concat(forecastRows);
    const latestHistorical = historicalRows.length ? historicalRows[historicalRows.length - 1] : null;
    const firstForecast = forecastRows.length ? forecastRows[0] : null;
    const extractedWarnings = Array.isArray(structured.warnings) ? structured.warnings.slice() : [];
    const extractedAssumptions = Array.isArray(structured.assumptions) ? structured.assumptions.slice() : [];
    const entryDate = toUtcDate(profile?.entryDate || structured.entry_date);

    return {
      companyName: structured.company_name || profile?.companyName || null,
      currency: structured.currency || profile?.currency || null,
      sourceUnits: units,
      normalizedUnits: 'ones',
      unitMultiplier: multiplier,
      entryDate: formatIsoDate(entryDate),
      extractedAssumptions,
      extractedWarnings,
      normalizationWarnings: warnings,
      historicalPeriods: historicalRows.map(row => ({
        ...row,
        grossMargin: deriveGrossMargin(row.revenue, row.grossProfit),
        ebitdaMargin: deriveMargin(row.revenue, row.ebitda),
      })),
      forecastPeriods: forecastRows.map(row => ({
        ...row,
        grossMargin: deriveGrossMargin(row.revenue, row.grossProfit),
        ebitdaMargin: deriveMargin(row.revenue, row.ebitda),
      })),
      ltmRevenue: latestHistorical ? latestHistorical.revenue : null,
      ltmEbitda: latestHistorical ? latestHistorical.ebitda : null,
      ntmRevenue: firstForecast ? firstForecast.revenue : null,
      ntmEbitda: firstForecast ? firstForecast.ebitda : null,
      latestHistoricalPeriodLabel: latestHistorical ? latestHistorical.periodLabel : null,
      firstForecastPeriodLabel: firstForecast ? firstForecast.periodLabel : null,
      latestKnownMargin: deriveLatestKnownMargin(allKnownPeriods),
      latestKnownGrossMargin: deriveLatestKnownGrossMargin(allKnownPeriods),
      latestRevenueGrowthRate: deriveLatestRevenueGrowthRate(allKnownPeriods),
      historicalRevenueGrowthRate: deriveHistoricalRevenueGrowthRate(historicalRows),
    };
  }

  function normalizeSeriesAssumption(value, holdYears, fieldName, warnings, options) {
    const source = asArray(value);
    if (!source) return null;

    const items = source.map(item => options && options.percent ? normalizeRate(item, fieldName, warnings, options) : toNumber(item));
    if (items.some(item => item === null)) {
      return { error: `${fieldName} contains a non-numeric value.` };
    }
    if (items.length === 1) {
      return Array.from({ length: holdYears }, () => items[0]);
    }
    if (items.length !== holdYears) {
      return { error: `${fieldName} must contain either one value or ${holdYears} yearly values.` };
    }

    return items;
  }

  function resolveAssumptions(profile, assumptions) {
    const warnings = [];
    const errors = [];
    const input = assumptions || {};
    const holdYears = Math.trunc(toNumber(input.holdYears));

    if (!Number.isInteger(holdYears) || holdYears <= 0) {
      errors.push('holdYears must be a positive integer.');
    }

    const entryDate = toUtcDate(input.entryDate || profile.entryDate);
    if (!entryDate) {
      errors.push('entryDate is required for IRR/XIRR calculations.');
    }

    const resolved = {
      entryDate: formatIsoDate(entryDate),
      entryMultiple: toNumber(input.entryMultiple),
      exitMultiple: toNumber(input.exitMultiple),
      leverage: toNumber(input.leverage),
      fiscalYearEndMonth: Math.trunc(toNumber(input.fiscalYearEndMonth)),
      minimumCash: null,
      holdYears,
      pretaxUfcfConversionRates: null,
      interestRate: MODEL_CONSTANTS.interestRate,
      taxRate: MODEL_CONSTANTS.taxRate,
      advisoryFeesPct: MODEL_CONSTANTS.advisoryFeesPct,
      financingFeesPct: MODEL_CONSTANTS.financingFeesPct,
      mipPct: MODEL_CONSTANTS.mipPct,
    };

    for (const field of ['entryMultiple', 'exitMultiple', 'leverage']) {
      if (!isFiniteNumber(resolved[field])) {
        errors.push(`${field} is required.`);
      }
    }

    if (!Number.isInteger(resolved.fiscalYearEndMonth)) {
      resolved.fiscalYearEndMonth = 12;
    }

    if (resolved.fiscalYearEndMonth < 1 || resolved.fiscalYearEndMonth > 12) {
      errors.push('fiscalYearEndMonth must be an integer between 1 and 12.');
    }

    const minimumCashInSourceUnits = toNumber(input.minimumCashInSourceUnits);
    const minimumCashAbsolute = toNumber(input.minimumCash);
    if (isFiniteNumber(minimumCashInSourceUnits)) {
      resolved.minimumCash = minimumCashInSourceUnits * profile.unitMultiplier;
    } else {
      resolved.minimumCash = minimumCashAbsolute;
    }

    if (isFiniteNumber(resolved.minimumCash) && resolved.minimumCash < 0) {
      errors.push('minimumCash cannot be negative.');
    }
    if (isFiniteNumber(resolved.leverage) && resolved.leverage < 0) {
      errors.push('leverage cannot be negative.');
    }
    if (isFiniteNumber(resolved.entryMultiple) && resolved.entryMultiple <= 0) {
      errors.push('entryMultiple must be greater than zero.');
    }
    if (isFiniteNumber(resolved.exitMultiple) && resolved.exitMultiple <= 0) {
      errors.push('exitMultiple must be greater than zero.');
    }

    const pretaxUfcfConversionRates = normalizeSeriesAssumption(
      input.pretaxUfcfConversionRates || input.pretaxUfcfConversionRate || input.pretaxUfcfConversion || input.cashConversionPct,
      resolved.holdYears || 1,
      'pretaxUfcfConversionRates',
      warnings,
      { percent: true, allowNegative: true }
    );
    const mipPct = normalizeRate(
      input.mipPct || input.mepPct || input.managementEquityPlanPct,
      'mipPct',
      warnings,
      { percent: true, allowNegative: false }
    );

    for (const [field, value] of Object.entries({ pretaxUfcfConversionRates })) {
      if (value && value.error) {
        errors.push(value.error);
      } else {
        resolved[field] = value;
      }
    }

    if (mipPct !== null) {
      resolved.mipPct = mipPct;
    }

    if (!resolved.pretaxUfcfConversionRates) {
      errors.push('pretaxUfcfConversion is required.');
    }

    if (isFiniteNumber(resolved.mipPct) && (resolved.mipPct < 0 || resolved.mipPct > 1)) {
      errors.push('mipPct must be between 0% and 100%.');
    }

    return { resolved, warnings, errors };
  }

  function validateModelInputs(profileInput, assumptions) {
    const normalizedProfile = normalizeExtractedProfile(profileInput);
    const { resolved, warnings: assumptionWarnings, errors } = resolveAssumptions(normalizedProfile, assumptions);
    const warnings = normalizedProfile.normalizationWarnings.concat(normalizedProfile.extractedWarnings || [], assumptionWarnings);

    if (!isFiniteNumber(normalizedProfile.ltmEbitda)) {
      errors.push('The extracted CIM profile is missing LTM EBITDA.');
    } else if (normalizedProfile.ltmEbitda <= 0) {
      warnings.push('LTM EBITDA is non-positive. Entry debt and default minimum cash will be floored at zero.');
    }

    const entryNtmBlend = calculateTrueNtmProfile(normalizedProfile, resolved, warnings);
    if (!entryNtmBlend || !isFiniteNumber(entryNtmBlend.ebitda)) {
      errors.push('NTM EBITDA is missing from the extracted CIM profile for the selected entry date and fiscal year end.');
    } else if (entryNtmBlend.ebitda <= 0) {
      errors.push('NTM EBITDA for the selected entry date must be greater than zero.');
    }

    if (!normalizedProfile.forecastPeriods.length) {
      warnings.push('No forecast periods were extracted. Revenue will be held flat from the latest CIM revenue where necessary.');
    }

    if (!isFiniteNumber(normalizedProfile.ntmRevenue)) {
      warnings.push('NTM revenue is missing. Revenue will be held flat from LTM where necessary.');
    }

    return {
      normalizedProfile,
      resolvedAssumptions: resolved,
      errors,
      warnings,
    };
  }

  function findPeriodByFiscalYear(periods, fiscalYear) {
    if (!Array.isArray(periods) || !Number.isInteger(fiscalYear)) return null;
    return periods.find(period => period.fiscalYear === fiscalYear) || null;
  }

  function calculateTrueNtmProfile(profile, assumptions, warnings) {
    const entryDate = toUtcDate(assumptions.entryDate);
    const fiscalYearEndMonth = assumptions.fiscalYearEndMonth;
    if (!entryDate || !Number.isInteger(fiscalYearEndMonth)) return null;

    const weights = getNextTwelveMonthFiscalWeights(entryDate, fiscalYearEndMonth);
    if (!weights.length) return null;

    const breakdown = [];
    let blendedRevenue = 0;
    let blendedEbitda = 0;
    let hasRevenue = true;

    for (const weightRow of weights) {
      const period = findPeriodByFiscalYear(profile.forecastPeriods, weightRow.fiscalYear);
      if (!period || !isFiniteNumber(period.ebitda)) {
        pushUnique(warnings, `A CIM forecast EBITDA value is required for fiscal year ${weightRow.fiscalYear} to calculate blended NTM EBITDA.`);
        return null;
      }

      if (!isFiniteNumber(period.revenue)) {
        hasRevenue = false;
      } else {
        blendedRevenue += period.revenue * weightRow.weight;
      }

      blendedEbitda += period.ebitda * weightRow.weight;
      breakdown.push({
        periodLabel: period.periodLabel,
        fiscalYear: period.fiscalYear,
        months: weightRow.months,
        weight: roundRatio(weightRow.weight),
        revenue: isFiniteNumber(period.revenue) ? roundCurrency(period.revenue) : null,
        ebitda: roundCurrency(period.ebitda),
      });
    }

    const label = breakdown.map(item => item.periodLabel).join(' / ');
    pushUnique(warnings, `Entry NTM EBITDA was blended using ${label}.`);

    return {
      periodLabel: label,
      fiscalYear: breakdown.length ? breakdown[0].fiscalYear : null,
      revenue: hasRevenue ? blendedRevenue : null,
      ebitda: blendedEbitda,
      breakdown,
    };
  }

  function getFirstProjectionCashAccrualFactor(assumptions) {
    const entryDate = toUtcDate(assumptions.entryDate);
    if (!entryDate || !Number.isInteger(assumptions.fiscalYearEndMonth)) {
      return 1;
    }

    const entryFiscalYear = getEntryFiscalYear(entryDate, assumptions.fiscalYearEndMonth);
    const weights = getNextTwelveMonthFiscalWeights(entryDate, assumptions.fiscalYearEndMonth);
    const matchingWeight = weights.find(row => row.fiscalYear === entryFiscalYear);
    return matchingWeight ? matchingWeight.weight : 1;
  }

  function resolveProjectedPeriod(profile, targetFiscalYear, previousRevenue, previousMargin, previousGrossMargin, warnings) {
    const extractedForecast = findPeriodByFiscalYear(profile.forecastPeriods, targetFiscalYear);
    if (extractedForecast && isFiniteNumber(extractedForecast.revenue) && isFiniteNumber(extractedForecast.ebitda)) {
      const grossMargin = isFiniteNumber(extractedForecast.grossMargin)
        ? extractedForecast.grossMargin
        : isFiniteNumber(previousGrossMargin)
          ? previousGrossMargin
          : profile.latestKnownGrossMargin;
      const grossProfit = isFiniteNumber(extractedForecast.grossProfit)
        ? extractedForecast.grossProfit
        : isFiniteNumber(grossMargin)
          ? extractedForecast.revenue * grossMargin
          : null;
      return {
        periodLabel: extractedForecast.periodLabel,
        fiscalYear: extractedForecast.fiscalYear,
        revenue: extractedForecast.revenue,
        grossProfit,
        ebitda: extractedForecast.ebitda,
        grossMargin,
        margin: deriveMargin(extractedForecast.revenue, extractedForecast.ebitda),
        source: 'CIM forecast',
      };
    }

    if (!isFiniteNumber(previousRevenue)) {
      return null;
    }

    const revenueGrowthRate = isFiniteNumber(profile.latestRevenueGrowthRate)
      ? profile.latestRevenueGrowthRate
      : isFiniteNumber(profile.historicalRevenueGrowthRate)
        ? profile.historicalRevenueGrowthRate
        : 0;
    const revenue = previousRevenue * (1 + revenueGrowthRate);
    const margin = isFiniteNumber(previousMargin) ? previousMargin : profile.latestKnownMargin;
    const grossMargin = isFiniteNumber(previousGrossMargin) ? previousGrossMargin : profile.latestKnownGrossMargin;
    if (!isFiniteNumber(margin)) {
      return null;
    }

    warnings.push(`Fiscal year ${targetFiscalYear} was extrapolated using the latest provided CIM revenue growth and a constant EBITDA margin.`);
    return {
      periodLabel: `FY${String(targetFiscalYear).slice(-2)}E`,
      fiscalYear: targetFiscalYear,
      revenue,
      grossProfit: isFiniteNumber(grossMargin) ? revenue * grossMargin : null,
      ebitda: revenue * margin,
      grossMargin,
      margin,
      source: 'Extrapolated',
    };
  }

  function buildEntry(profile, assumptions, warnings) {
    const entryNtmBlend = calculateTrueNtmProfile(profile, assumptions, warnings);
    if (!entryNtmBlend || !isFiniteNumber(entryNtmBlend.ebitda)) {
      throw new Error('Unable to determine NTM EBITDA for the entry valuation.');
    }

    const debtBaseEbitda = Math.max(0, profile.ltmEbitda);
    const minimumCash = isFiniteNumber(assumptions.minimumCash) ? assumptions.minimumCash : Math.max(0, profile.ltmEbitda / 3);
    if (!isFiniteNumber(assumptions.minimumCash)) {
      warnings.push(debtBaseEbitda > 0
        ? 'minimumCash was not provided and defaulted to LTM EBITDA divided by 3.'
        : 'minimumCash was not provided and defaulted to zero because LTM EBITDA is non-positive.');
    }

    const entryEv = entryNtmBlend.ebitda * assumptions.entryMultiple;
    const debt = debtBaseEbitda * assumptions.leverage;
    const advisoryFees = entryEv * assumptions.advisoryFeesPct;
    const financingFees = debt * assumptions.financingFeesPct;
    const uses = entryEv + advisoryFees + financingFees + minimumCash;
    const pfEquity = uses - debt;

    return {
      entryEv: roundCurrency(entryEv),
      debt: roundCurrency(debt),
      advisoryFees: roundCurrency(advisoryFees),
      financingFees: roundCurrency(financingFees),
      minimumCash: roundCurrency(minimumCash),
      uses: roundCurrency(uses),
      pfEquity: roundCurrency(pfEquity),
      ltmEbitda: roundCurrency(profile.ltmEbitda),
      ntmRevenue: roundCurrency(entryNtmBlend.revenue),
      ntmEbitda: roundCurrency(entryNtmBlend.ebitda),
      ntmPeriodLabel: entryNtmBlend.periodLabel,
      ntmFiscalYear: entryNtmBlend.fiscalYear,
      ntmBlendBreakdown: entryNtmBlend.breakdown,
    };
  }

  function buildOperatingProjection(profile, assumptions, entry, warnings) {
    const rows = [];
    const entryFiscalYear = getEntryFiscalYear(toUtcDate(assumptions.entryDate), assumptions.fiscalYearEndMonth);
    if (!entryFiscalYear) {
      throw new Error('Unable to align the operating projection to the entry fiscal year.');
    }
    const firstYearCashAccrualFactor = getFirstProjectionCashAccrualFactor(assumptions);
    if (firstYearCashAccrualFactor < 1) {
      pushUnique(
        warnings,
        `Year 1 end-of-period cash reflects ${Math.round(firstYearCashAccrualFactor * 12)}/12 of post-tax cash flow based on the entry date.`
      );
    }

    let previousRevenue = profile.ltmRevenue;
    let previousMargin = profile.latestKnownMargin;
    let previousCash = entry.minimumCash;
    const debtBalance = entry.debt;
    let previousGrossMargin = profile.latestKnownGrossMargin;

    for (let yearIndex = 0; yearIndex < assumptions.holdYears; yearIndex += 1) {
      const targetFiscalYear = entryFiscalYear + yearIndex;
      const projectedPeriod = resolveProjectedPeriod(profile, targetFiscalYear, previousRevenue, previousMargin, previousGrossMargin, warnings);

      if (!projectedPeriod || !isFiniteNumber(projectedPeriod.revenue) || !isFiniteNumber(projectedPeriod.ebitda)) {
        throw new Error(`Unable to build operating projection for year ${yearIndex + 1}.`);
      }

      const pretaxUfcfConversion = assumptions.pretaxUfcfConversionRates[yearIndex];
      const capexRate = (1 - pretaxUfcfConversion) * 0.5;
      const capex = projectedPeriod.ebitda * capexRate;
      const ebit = projectedPeriod.ebitda - capex;
      const sgna = isFiniteNumber(projectedPeriod.grossProfit) ? projectedPeriod.grossProfit - projectedPeriod.ebitda : null;
      const pretaxUfcf = projectedPeriod.ebitda * pretaxUfcfConversion;
      const interest = debtBalance * assumptions.interestRate;
      const tax = Math.max(pretaxUfcf - interest, 0) * assumptions.taxRate;
      const postTaxCashFlow = pretaxUfcf - interest - tax;
      const cashAccrualFactor = yearIndex === 0 ? firstYearCashAccrualFactor : 1;
      const realizedPostTaxCashFlow = postTaxCashFlow * cashAccrualFactor;
      const cashEop = previousCash + realizedPostTaxCashFlow;

      rows.push({
        year: yearIndex + 1,
        periodLabel: projectedPeriod.periodLabel,
        fiscalYear: projectedPeriod.fiscalYear,
        revenue: roundCurrency(projectedPeriod.revenue),
        grossProfit: roundCurrency(projectedPeriod.grossProfit),
        grossMargin: roundRatio(projectedPeriod.grossMargin),
        sgna: roundCurrency(sgna),
        ebitda: roundCurrency(projectedPeriod.ebitda),
        ebitdaMargin: roundRatio(projectedPeriod.margin),
        pretaxUfcfConversion: roundRatio(pretaxUfcfConversion),
        capex: roundCurrency(capex),
        ebit: roundCurrency(ebit),
        pretaxUfcf: roundCurrency(pretaxUfcf),
        tax: roundCurrency(tax),
        interest: roundCurrency(interest),
        postTaxCashFlow: roundCurrency(postTaxCashFlow),
        realizedPostTaxCashFlow: roundCurrency(realizedPostTaxCashFlow),
        cashAccrualFactor: roundRatio(cashAccrualFactor),
        cashEop: roundCurrency(cashEop),
        debtEop: roundCurrency(debtBalance),
        ebitdaSource: projectedPeriod.source,
      });

      previousRevenue = projectedPeriod.revenue;
      previousMargin = projectedPeriod.margin || previousMargin;
      previousGrossMargin = projectedPeriod.grossMargin || previousGrossMargin;
      previousCash = cashEop;
    }

    return rows;
  }

  function buildExit(profile, assumptions, entry, finalYear, warnings) {
    const exitFiscalYear = finalYear.fiscalYear + 1;
    const exitForwardPeriod = resolveProjectedPeriod(
      profile,
      exitFiscalYear,
      finalYear.revenue,
      finalYear.ebitdaMargin,
      finalYear.grossMargin,
      warnings
    );
    if (!exitForwardPeriod || !isFiniteNumber(exitForwardPeriod.ebitda)) {
      throw new Error('Unable to determine exit forward EBITDA.');
    }

    const exitEv = exitForwardPeriod.ebitda * assumptions.exitMultiple;
    const exitEquityBeforeMip = exitEv - finalYear.debtEop + finalYear.cashEop;
    const grossCapitalGain = exitEquityBeforeMip - entry.pfEquity;
    const mip = -1 * grossCapitalGain * assumptions.mipPct;
    const pfEquityExit = exitEquityBeforeMip + mip;

    return {
      exitEv: roundCurrency(exitEv),
      exitEquityBeforeMip: roundCurrency(exitEquityBeforeMip),
      grossCapitalGain: roundCurrency(grossCapitalGain),
      exitForwardPeriodLabel: exitForwardPeriod.periodLabel,
      exitForwardFiscalYear: exitForwardPeriod.fiscalYear,
      exitForwardRevenue: roundCurrency(exitForwardPeriod.revenue),
      exitForwardGrossProfit: roundCurrency(exitForwardPeriod.grossProfit),
      exitForwardGrossMargin: roundRatio(exitForwardPeriod.grossMargin),
      exitForwardMargin: roundRatio(exitForwardPeriod.margin),
      debtAtExit: roundCurrency(finalYear.debtEop),
      cashAtExit: roundCurrency(finalYear.cashEop),
      mip: roundCurrency(mip),
      pfEquityExit: roundCurrency(pfEquityExit),
      finalYearEbitda: roundCurrency(exitForwardPeriod.ebitda),
    };
  }

  function xnpv(rate, cashFlows) {
    const firstDate = cashFlows[0].date.getTime();
    return cashFlows.reduce((sum, cashFlow) => {
      const days = (cashFlow.date.getTime() - firstDate) / 86400000;
      return sum + (cashFlow.amount / Math.pow(1 + rate, days / 365));
    }, 0);
  }

  function dxnpv(rate, cashFlows) {
    const firstDate = cashFlows[0].date.getTime();
    return cashFlows.reduce((sum, cashFlow) => {
      const days = (cashFlow.date.getTime() - firstDate) / 86400000;
      const exponent = days / 365;
      if (exponent === 0) return sum;
      return sum - ((exponent * cashFlow.amount) / Math.pow(1 + rate, exponent + 1));
    }, 0);
  }

  function calculateXirr(cashFlows) {
    if (!Array.isArray(cashFlows) || cashFlows.length < 2) return null;
    if (!cashFlows.some(flow => flow.amount > 0) || !cashFlows.some(flow => flow.amount < 0)) return null;

    let rate = 0.2;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const value = xnpv(rate, cashFlows);
      const derivative = dxnpv(rate, cashFlows);
      if (Math.abs(value) < 0.000001) return rate;
      if (!Number.isFinite(derivative) || derivative === 0) break;
      const nextRate = rate - (value / derivative);
      if (!Number.isFinite(nextRate) || nextRate <= -0.9999999999) break;
      if (Math.abs(nextRate - rate) < 0.0000001) return nextRate;
      rate = nextRate;
    }

    let lower = -0.9999;
    let upper = 10;
    let lowerValue = xnpv(lower, cashFlows);
    let upperValue = xnpv(upper, cashFlows);
    if (lowerValue * upperValue > 0) return null;

    for (let attempt = 0; attempt < 200; attempt += 1) {
      const midpoint = (lower + upper) / 2;
      const midpointValue = xnpv(midpoint, cashFlows);
      if (Math.abs(midpointValue) < 0.000001) return midpoint;
      if (lowerValue * midpointValue < 0) {
        upper = midpoint;
        upperValue = midpointValue;
      } else {
        lower = midpoint;
        lowerValue = midpointValue;
      }
    }

    return (lower + upper) / 2;
  }

  function buildReturns(assumptions, entry, exit) {
    const entryDate = toUtcDate(assumptions.entryDate);
    const exitDate = addYears(entryDate, assumptions.holdYears);
    const irr = calculateXirr([
      { date: entryDate, amount: -entry.pfEquity },
      { date: exitDate, amount: exit.pfEquityExit },
    ]);

    return {
      mom: roundRatio(exit.pfEquityExit / entry.pfEquity),
      irr: roundRatio(irr),
      cashFlows: [
        { date: formatIsoDate(entryDate), amount: roundCurrency(-entry.pfEquity) },
        { date: formatIsoDate(exitDate), amount: roundCurrency(exit.pfEquityExit) },
      ],
      entryDate: formatIsoDate(entryDate),
      exitDate: formatIsoDate(exitDate),
    };
  }

  function buildValueCreationBridge(assumptions, entry, exit, warnings) {
    const entryRevenue = entry.ntmRevenue;
    const exitRevenue = exit.exitForwardRevenue;
    const entryMargin = isFiniteNumber(entry.ntmRevenue) && entry.ntmRevenue !== 0 && isFiniteNumber(entry.ntmEbitda)
      ? entry.ntmEbitda / entry.ntmRevenue
      : null;
    const exitMargin = exit.exitForwardMargin;

    const components = [
      {
        key: 'revenueGrowth',
        label: 'Revenue Growth',
        value: roundCurrency(
          isFiniteNumber(exitRevenue) && isFiniteNumber(entryRevenue) && isFiniteNumber(entryMargin)
            ? (exitRevenue - entryRevenue) * entryMargin * assumptions.entryMultiple
            : null
        ),
      },
      {
        key: 'marginExpansion',
        label: 'Margin Expansion',
        value: roundCurrency(
          isFiniteNumber(exitMargin) && isFiniteNumber(entryMargin) && isFiniteNumber(exitRevenue)
            ? (exitMargin - entryMargin) * exitRevenue * assumptions.entryMultiple
            : null
        ),
      },
      {
        key: 'multipleExpansion',
        label: 'Multiple Expansion',
        value: roundCurrency(
          isFiniteNumber(exit.finalYearEbitda)
            ? exit.finalYearEbitda * (assumptions.exitMultiple - assumptions.entryMultiple)
            : null
        ),
      },
      {
        key: 'cashFlow',
        label: 'Cash Flow',
        value: roundCurrency(
          isFiniteNumber(exit.cashAtExit) && isFiniteNumber(entry.minimumCash) && isFiniteNumber(exit.debtAtExit) && isFiniteNumber(entry.debt)
            ? (exit.cashAtExit - entry.minimumCash) - (exit.debtAtExit - entry.debt)
            : null
        ),
      },
      {
        key: 'mep',
        label: 'MEP',
        value: roundCurrency(exit.mip),
      },
      {
        key: 'fees',
        label: 'Fees',
        value: roundCurrency(-1 * ((entry.advisoryFees || 0) + (entry.financingFees || 0))),
      },
    ];

    const entryEquity = roundCurrency(entry.pfEquity);
    const exitEquity = roundCurrency(exit.pfEquityExit);
    const bridgeSumBeforeAdjustment = components.reduce(
      (sum, component) => sum + (isFiniteNumber(component.value) ? component.value : 0),
      isFiniteNumber(entryEquity) ? entryEquity : 0
    );
    const roundingAdjustment = roundCurrency(
      isFiniteNumber(exitEquity) ? exitEquity - bridgeSumBeforeAdjustment : null
    );

    if (isFiniteNumber(roundingAdjustment) && Math.abs(roundingAdjustment) > 1 && Array.isArray(warnings)) {
      pushUnique(
        warnings,
        `Value creation bridge does not reconcile to exit equity within tolerance before adjustment (difference: ${roundCurrency(roundingAdjustment)}).`
      );
    }

    const steps = [
      {
        key: 'entryEquity',
        label: 'Entry Equity',
        type: 'total',
        value: entryEquity,
      },
      ...components.map(component => ({
        ...component,
        type: 'delta',
      })),
      {
        key: 'exitEquity',
        label: 'Exit Equity',
        type: 'total',
        value: exitEquity,
      },
    ];

    let runningTotal = entryEquity;
    for (const step of steps) {
      if (step.type === 'total') {
        step.start = 0;
        step.end = step.value;
        if (step.key === 'entryEquity') {
          runningTotal = step.value;
        } else if (step.key === 'exitEquity') {
          runningTotal = step.value;
        }
        step.runningTotal = runningTotal;
      } else {
        step.start = runningTotal;
        step.end = runningTotal + step.value;
        runningTotal = step.end;
        step.runningTotal = runningTotal;
      }
    }

    return {
      entryEquity,
      exitEquity,
      entryRevenue: roundCurrency(entryRevenue),
      exitRevenue: roundCurrency(exitRevenue),
      entryMargin: roundRatio(entryMargin),
      exitMargin: roundRatio(exitMargin),
      discrepancyBeforeAdjustment: roundingAdjustment,
      steps,
    };
  }

  function calculateReturns(profileInput, assumptions) {
    const validation = validateModelInputs(profileInput, assumptions);
    const warnings = validation.warnings.slice();

    if (validation.errors.length) {
      return {
        normalizedProfile: validation.normalizedProfile,
        assumptions: validation.resolvedAssumptions,
        constants: MODEL_CONSTANTS,
        entry: null,
        operatingProjection: [],
        exit: null,
        returns: null,
        valueCreationBridge: null,
        warnings,
        validation: {
          errors: validation.errors,
          warnings,
        },
      };
    }

    try {
      const entry = buildEntry(validation.normalizedProfile, validation.resolvedAssumptions, warnings);
      const operatingProjection = buildOperatingProjection(validation.normalizedProfile, validation.resolvedAssumptions, entry, warnings);
      const exit = buildExit(validation.normalizedProfile, validation.resolvedAssumptions, entry, operatingProjection[operatingProjection.length - 1], warnings);
      const returns = buildReturns(validation.resolvedAssumptions, entry, exit);
      const valueCreationBridge = buildValueCreationBridge(validation.resolvedAssumptions, entry, exit, warnings);

      return {
        normalizedProfile: validation.normalizedProfile,
        assumptions: validation.resolvedAssumptions,
        constants: MODEL_CONSTANTS,
        entry,
        operatingProjection,
        exit,
        returns,
        valueCreationBridge,
        warnings,
        validation: {
          errors: [],
          warnings,
        },
      };
    } catch (error) {
      return {
        normalizedProfile: validation.normalizedProfile,
        assumptions: validation.resolvedAssumptions,
        constants: MODEL_CONSTANTS,
        entry: null,
        operatingProjection: [],
        exit: null,
        returns: null,
        valueCreationBridge: null,
        warnings,
        validation: {
          errors: [error.message || 'Returns calculation failed.'],
          warnings,
        },
      };
    }
  }

  return {
    MODEL_CONSTANTS,
    UNIT_MULTIPLIERS,
    normalizeExtractedProfile,
    validateModelInputs,
    calculateReturns,
    calculateXirr,
  };
});
