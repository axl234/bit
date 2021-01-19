import chai, { expect } from 'chai';
import fs from 'fs-extra';
import path from 'path';
import NpmCiRegistry, { supportNpmCiRegistryTesting } from '../npm-ci-registry';

import { HARMONY_FEATURE } from '../../src/api/consumer/lib/feature-toggle';
import Helper from '../../src/e2e-helper/e2e-helper';
import { DEFAULT_OWNER } from '../../src/e2e-helper/e2e-scopes';

chai.use(require('chai-fs'));

/**
 * different scenarios of when a component or a version is missing from the original scope.
 * in all e2-tests below, we're dealing with 3 components.
 * scopeA/comp1 -> scopeA/comp2 -> scopeB/comp3.
 * for comp1 perspective, the comp2 is a direct-dep, comp3 is an indirect-dep.
 *
 * @todo: test the following cases
 * 1. delete the package of the deleted component and make sure it's possible to import it (maybe with a flag of disable-npm-install)
 * 2. the entire scope of flattened-dependency is down. make sure that it fetches the component from cache of direct.
 */
describe('recovery after component/scope deletion', function () {
  this.timeout(0);
  let helper: Helper;
  let npmCiRegistry: NpmCiRegistry;
  before(() => {
    helper = new Helper({ scopesOptions: { remoteScopeWithDot: true } });
    helper.command.setFeatures(HARMONY_FEATURE);
  });
  after(() => {
    helper.scopeHelper.destroy();
  });
  (supportNpmCiRegistryTesting ? describe : describe.skip)('indirect-dep scope has re-initiated', () => {
    let scopeWithoutOwner: string;
    let secondRemotePath: string;
    let secondRemoteName: string;
    before(async () => {
      helper.scopeHelper.setNewLocalAndRemoteScopesHarmony();
      helper.bitJsonc.setupDefault();
      scopeWithoutOwner = helper.scopes.remoteWithoutOwner;
      npmCiRegistry = new NpmCiRegistry(helper);
      npmCiRegistry.configureCiInPackageJsonHarmony();
      await npmCiRegistry.init();
      const secondRemote = helper.scopeHelper.getNewBareScope(undefined, true);
      secondRemotePath = secondRemote.scopePath;
      secondRemoteName = secondRemote.scopeName;
      helper.scopeHelper.addRemoteScope(secondRemote.scopePath);
      helper.fs.outputFile('comp1/index.js', `require('@${DEFAULT_OWNER}/${scopeWithoutOwner}.comp2');`);
      helper.fs.outputFile('comp2/index.js', `require('@${DEFAULT_OWNER}/${secondRemote.scopeWithoutOwner}.comp3');`);
      helper.fs.outputFile('comp3/index.js', '');
      helper.command.addComponent('comp1');
      helper.command.addComponent('comp2');
      helper.command.addComponent('comp3');
      helper.bitJsonc.addToVariant('comp3', 'defaultScope', secondRemoteName);
      helper.command.linkAndCompile();
      helper.command.tagAllComponents();
      helper.command.export();
      helper.scopeHelper.reInitRemoteScope(secondRemotePath);
    });
    after(() => {
      npmCiRegistry.destroy();
    });
    describe('indirect dependency is missing', () => {
      let scopeWithMissingDep: string;
      before(() => {
        helper.scopeHelper.reInitLocalScopeHarmony();
        helper.scopeHelper.addRemoteScope(secondRemotePath);
        npmCiRegistry.setResolver();
        helper.command.importComponent('comp1');
        // delete the comp3 from the scope.
        const hashPath = helper.general.getHashPathOfComponent('comp3');
        fs.removeSync(path.join(helper.scopes.localPath, '.bit/objects', hashPath));
        fs.removeSync(path.join(helper.scopes.localPath, '.bit/index.json'));
        scopeWithMissingDep = helper.scopeHelper.cloneLocalScope();
      });
      it('an intermediate check. the scope should not have the comp3 object', () => {
        const scope = helper.command.catScope(true);
        const comp3 = scope.find((item) => item.name === 'comp3');
        expect(comp3).to.be.undefined;
      });
      describe('the indirect dependency exists as cache inside the dependent scope', () => {
        describe('bit tag', () => {
          let tagOutput;
          before(() => {
            tagOutput = helper.command.tagWithoutBuild('comp1', '--force');
          });
          it('should succeed', () => {
            expect(tagOutput).to.have.string('1 component(s) tagged');
          });
          it('should bring the missing dep from the dependent', () => {
            const scope = helper.command.catScope(true);
            const comp3 = scope.find((item) => item.name === 'comp3');
            expect(comp3).to.not.be.undefined;
          });
        });
        describe('bit import', () => {
          before(() => {
            helper.scopeHelper.getClonedLocalScope(scopeWithMissingDep);
            helper.command.importAllComponents();
          });
          it('should bring the missing dep from the dependent', () => {
            const scope = helper.command.catScope(true);
            const comp3 = scope.find((item) => item.name === 'comp3');
            expect(comp3).to.not.be.undefined;
          });
        });
      });
      describe('the indirect dependency is missing in the dependent scope as well', () => {
        before(() => {
          // delete the comp3 from the remote scope.
          const hashPath = helper.general.getHashPathOfComponent('comp3', helper.scopes.remotePath);
          fs.removeSync(path.join(helper.scopes.remotePath, 'objects', hashPath));
          fs.removeSync(path.join(helper.scopes.remotePath, 'index.json'));
          helper.scopeHelper.addRemoteScope(secondRemotePath, helper.scopes.remotePath);
        });
        it('an intermediate check. the scope should not have the comp3 object', () => {
          const scope = helper.command.catScope(true, helper.scopes.remotePath);
          const comp3 = scope.find((item) => item.name === 'comp3');
          expect(comp3).to.be.undefined;
        });
        describe('bit import', () => {
          before(() => {
            helper.scopeHelper.getClonedLocalScope(scopeWithMissingDep);
            helper.command.importAllComponents();
          });
          it('should not throw an error and not bring the missing dep', () => {
            const scope = helper.command.catScope(true);
            const comp3 = scope.find((item) => item.name === 'comp3');
            expect(comp3).to.be.undefined;
          });
        });
        describe('bit tag', () => {
          it('should throw an error about missing dependencies', () => {
            expect(() => helper.command.tagWithoutBuild('comp1', '--force')).to.throw(
              'has the following dependencies missing'
            );
          });
        });
      });
    });
    // comp3 exits with 0.0.1 as cache of comp2/comp1 but in its origin it has only 0.0.2
    describe('indirect dependency has re-created with a different version', () => {
      before(() => {
        helper.scopeHelper.reInitLocalScopeHarmony();
        helper.scopeHelper.addRemoteScope(secondRemotePath);
        helper.fs.outputFile('comp3/index.js', '');
        helper.command.addComponent('comp3');
        helper.bitJsonc.addToVariant('comp3', 'defaultScope', secondRemoteName);
        helper.command.tagAllComponents('', '0.0.2');
        helper.command.export();
        helper.scopeHelper.reInitLocalScopeHarmony();
        helper.scopeHelper.addRemoteScope(secondRemotePath);
        npmCiRegistry.setResolver();
      });
      it('should import comp1 successfully and bring comp3@0.0.1 from the cache of comp1', () => {
        helper.command.importComponent('comp1');
        const scope = helper.command.catScope(true);
        const comp3 = scope.find((item) => item.name === 'comp3');
        expect(comp3).to.not.be.undefined;
        expect(comp3.versions).to.have.property('0.0.1');
        expect(comp3.versions).to.not.have.property('0.0.2');
      });
      it('should import comp2 successfully and bring comp3@0.0.1 from the cache of comp2', () => {
        helper.scopeHelper.reInitLocalScopeHarmony();
        helper.scopeHelper.addRemoteScope(secondRemotePath);
        npmCiRegistry.setResolver();
        helper.command.importComponent('comp2');
        const scope = helper.command.catScope(true);
        const comp3 = scope.find((item) => item.name === 'comp3');
        expect(comp3).to.not.be.undefined;
        expect(comp3.versions).to.have.property('0.0.1');
        expect(comp3.versions).to.not.have.property('0.0.2');
      });
      describe('importing both: comp1 and comp3 to the same workspace', () => {
        let beforeImportScope: string;
        before(() => {
          helper.scopeHelper.reInitLocalScopeHarmony();
          helper.scopeHelper.addRemoteScope(secondRemotePath);
          npmCiRegistry.setResolver();
          beforeImportScope = helper.scopeHelper.cloneLocalScope();
        });
        function expectToImportProperly() {
          it('comp3: should save 0.0.1 of in the orphanedVersions prop', () => {
            const comp3 = helper.command.catComponent(`${secondRemoteName}/comp3`);
            expect(comp3).to.have.property('orphanedVersions');
            expect(comp3.orphanedVersions).to.have.property('0.0.1');
          });
          it('comp3: should not have 0.0.1 in the versions object, only 0.0.2', () => {
            const comp3 = helper.command.catComponent(`${secondRemoteName}/comp3`);
            expect(comp3.versions).not.to.have.property('0.0.1');
            expect(comp3.versions).to.have.property('0.0.2');
          });
          it('comp3: the head should be the same as 0.0.2 not as 0.0.1', () => {
            const comp3 = helper.command.catComponent(`${secondRemoteName}/comp3`);
            const hash = comp3.versions['0.0.2'];
            expect(comp3.head === hash);
          });
          it('comp3: the remote ref hash should be the same as 0.0.2 not as 0.0.1', () => {
            const comp3 = helper.command.catComponent(`${secondRemoteName}/comp3`);
            const hash = comp3.versions['0.0.2'];

            const remoteRefs = helper.general.getRemoteRefPath(undefined, secondRemoteName);
            expect(remoteRefs).to.be.a.file();
            const remoteRefContent = fs.readJsonSync(remoteRefs);
            expect(remoteRefContent).to.deep.include({
              id: { scope: secondRemoteName, name: 'comp3' },
              head: hash,
            });
          });
        }
        // before, it was throwing NoCommonSnap in this case.
        describe('importing comp1 (comp3 as cached) first then comp3 (comp3 as direct)', () => {
          before(() => {
            helper.command.importComponent('comp1');
            helper.command.import(`${secondRemoteName}/comp3`);
          });
          expectToImportProperly();
        });
        // before, it was merging 0.0.1 into the current comp3 incorrectly. (versions prop had both 0.0.1 and 0.0.2)
        describe('importing comp3 (comp3 as direct) first then comp1 (comp3 as cached)', () => {
          before(() => {
            helper.scopeHelper.getClonedLocalScope(beforeImportScope);
            helper.command.import(`${secondRemoteName}/comp3`);
            helper.command.importComponent('comp1');
          });
          expectToImportProperly();
        });
        // before, it was throwing NoCommonSnap in this case.
        describe('importing comp3 (comp3 as direct) and comp1 (comp3 as cached) at the same time', () => {
          before(() => {
            helper.scopeHelper.getClonedLocalScope(beforeImportScope);
            helper.command.import(`${helper.scopes.remote}/comp1 ${secondRemoteName}/comp3`);
          });
          expectToImportProperly();
        });
      });
    });
  });
});
