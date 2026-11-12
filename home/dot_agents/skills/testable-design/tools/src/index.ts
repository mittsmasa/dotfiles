import facts from './rules/facts.ts';
import maxEffectsInComponent from './rules/max-effects-in-component.ts';
import maxModuleMocks from './rules/max-module-mocks.ts';
import noAmbientNondeterminism from './rules/no-ambient-nondeterminism.ts';
import noFetchInComponent from './rules/no-fetch-in-component.ts';
import noInternalModuleMock from './rules/no-internal-module-mock.ts';
import noInternalModuleSpy from './rules/no-internal-module-spy.ts';
import type { Plugin } from './types.ts';

const plugin: Plugin = {
  meta: { name: 'testable' },
  rules: {
    facts,
    'max-effects-in-component': maxEffectsInComponent,
    'max-module-mocks': maxModuleMocks,
    'no-ambient-nondeterminism': noAmbientNondeterminism,
    'no-fetch-in-component': noFetchInComponent,
    'no-internal-module-mock': noInternalModuleMock,
    'no-internal-module-spy': noInternalModuleSpy,
  },
};

export default plugin;
