import chai, { expect } from 'chai';
import fs from 'fs-extra';
import path from 'path';
import NpmCiRegistry, { supportNpmCiRegistryTesting } from '../npm-ci-registry';

import { HARMONY_FEATURE } from '../../src/api/consumer/lib/feature-toggle';
import Helper from '../../src/e2e-helper/e2e-helper';
import { DEFAULT_OWNER } from '../../src/e2e-helper/e2e-scopes';
import { ComponentNotFound } from '../../src/scope/exceptions';

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
 * 3. fix performance. bit-import on bit-bin is super slow. makes sure to not merge the same component multiple times if their content is the same, do not write the same hashes over and over
 * 4. make sure importing a version that was in orphanedVersions before doesn't save it twice. should be only in "versions".
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
      helper.scopeHelper.addRemoteScope(secondRemote.scopePath, helper.scopes.remotePath);
      helper.scopeHelper.addRemoteScope(helper.scopes.remotePath, secondRemote.scopePath);
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
      let remoteScope: string;
      before(() => {
        helper.scopeHelper.reInitLocalScopeHarmony();
        helper.scopeHelper.addRemoteScope(secondRemotePath);
        helper.bitJsonc.disablePreview();
        npmCiRegistry.setResolver();
        helper.command.importComponent('comp1');
        // delete the comp3 from the scope.
        const hashPath = helper.general.getHashPathOfComponent('comp3');
        fs.removeSync(path.join(helper.scopes.localPath, '.bit/objects', hashPath));
        fs.removeSync(path.join(helper.scopes.localPath, '.bit/index.json'));
        scopeWithMissingDep = helper.scopeHelper.cloneLocalScope();
        remoteScope = helper.scopeHelper.cloneRemoteScope();
      });
      after(() => {
        helper.scopeHelper.getClonedRemoteScope(remoteScope);
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
        describe('bit export to another remote', () => {
          let compNewRemote;
          before(() => {
            helper.scopeHelper.getClonedLocalScope(scopeWithMissingDep);
            helper.fs.outputFile('comp-new/index.js', `require('@${DEFAULT_OWNER}/${scopeWithoutOwner}.comp1');`);
            helper.command.addComponent('comp-new');
            compNewRemote = helper.scopeHelper.getNewBareScope('-remote3', true);
            helper.bitJsonc.addToVariant('comp-new', 'defaultScope', compNewRemote.scopeName);
            helper.command.tagAllComponents();
            helper.scopeHelper.addRemoteScope(compNewRemote.scopePath);
            helper.scopeHelper.addRemoteScope(helper.scopes.remotePath, compNewRemote.scopePath);
            helper.scopeHelper.addRemoteScope(secondRemotePath, compNewRemote.scopePath);
            helper.command.export();
          });
          it('this new remote should bring the flattened dependency (comp3) from the dependent scope', () => {
            const scope = helper.command.catScope(true, compNewRemote.scopePath);
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
    describe('direct dependency is missing', () => {
      let scopeWithMissingDep: string;
      let remoteScope: string;
      before(() => {
        helper.scopeHelper.reInitLocalScopeHarmony();
        helper.bitJsonc.setupDefault();
        npmCiRegistry.setResolver({ [secondRemoteName]: secondRemotePath });
        helper.command.importComponent('comp2');
        // delete the comp3 from the scope.
        const hashPath = helper.general.getHashPathOfComponent('comp3');
        fs.removeSync(path.join(helper.scopes.localPath, '.bit/objects', hashPath));
        fs.removeSync(path.join(helper.scopes.localPath, '.bit/index.json'));
        scopeWithMissingDep = helper.scopeHelper.cloneLocalScope();
        remoteScope = helper.scopeHelper.cloneRemoteScope();
      });
      after(() => {
        helper.scopeHelper.getClonedRemoteScope(remoteScope);
      });
      it('an intermediate check. the scope should not have the comp3 object', () => {
        const scope = helper.command.catScope(true);
        const comp3 = scope.find((item) => item.name === 'comp3');
        expect(comp3).to.be.undefined;
      });
      describe('the direct dependency exists as cache inside the dependent scope', () => {
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
        describe('bit tag', () => {
          let tagOutput;
          before(() => {
            helper.command.importAllComponents(); // otherwise, it shows "your workspace has outdated objects" warning.
            tagOutput = helper.command.tagWithoutBuild('comp2', '--force');
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
      });
      describe('the direct dependency is missing in the dependent scope as well', () => {
        before(() => {
          helper.scopeHelper.getClonedLocalScope(scopeWithMissingDep);
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
          let importOutput: string;
          before(() => {
            importOutput = helper.command.importAllComponents();
          });
          it('should not throw an error and not bring the missing dep', () => {
            const scope = helper.command.catScope(true);
            const comp3 = scope.find((item) => item.name === 'comp3');
            expect(comp3).to.be.undefined;
          });
          it('should indicate the dependencies are missing', () => {
            expect(importOutput).to.have.string(`missing dependencies: ${secondRemoteName}/comp3`);
          });
        });
        describe('bit tag', () => {
          before(() => {
            helper.scopeHelper.getClonedLocalScope(scopeWithMissingDep);
            helper.command.importAllComponents();
          });
          it('should throw ComponentNotFound error because it is a direct dependency', () => {
            const cmd = () => helper.command.tagWithoutBuild('comp2', '--force');
            const err = new ComponentNotFound(`${secondRemoteName}/comp3@0.0.1`);
            helper.general.expectToThrow(cmd, err);
          });
        });
      });
    });
    // comp3 exits with 0.0.1 as cache of comp2/comp1 but in its origin it has only 0.0.2
    describe('indirect dependency (comp3) has re-created with a different version', () => {
      let beforeImportScope: string;
      before(() => {
        helper.scopeHelper.reInitLocalScopeHarmony();
        helper.bitJsonc.disablePreview();
        helper.scopeHelper.addRemoteScope(secondRemotePath);
        helper.fs.outputFile('comp3/index.js', '');
        helper.command.addComponent('comp3');
        helper.bitJsonc.addToVariant('comp3', 'defaultScope', secondRemoteName);
        helper.command.tagAllComponents('', '0.0.2');
        helper.command.export();
        helper.scopeHelper.reInitLocalScopeHarmony();
        helper.scopeHelper.addRemoteScope(secondRemotePath);
        helper.bitJsonc.disablePreview();
        npmCiRegistry.setResolver();
        beforeImportScope = helper.scopeHelper.cloneLocalScope();
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
        helper.scopeHelper.getClonedLocalScope(beforeImportScope);
        helper.command.importComponent('comp2');
        const scope = helper.command.catScope(true);
        const comp3 = scope.find((item) => item.name === 'comp3');
        expect(comp3).to.not.be.undefined;
        expect(comp3.versions).to.have.property('0.0.1');
        expect(comp3.versions).to.not.have.property('0.0.2');
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
      describe('importing both: comp1 and flatten-dep comp3 to the same workspace ', () => {
        before(() => {
          helper.scopeHelper.getClonedLocalScope(beforeImportScope);
        });
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
      describe('importing both: comp2 and direct-dep comp3 to the same workspace', () => {
        // before, it was throwing ComponentNotFound error of comp3@0.0.1.
        describe('importing comp2 (comp3 as cached) and then comp3', () => {
          before(() => {
            helper.scopeHelper.getClonedLocalScope(beforeImportScope);
            helper.command.importComponent('comp2');
            helper.command.import(`${secondRemoteName}/comp3`);
          });
          expectToImportProperly();
        });
        describe('importing comp3 and then comp2', () => {
          before(() => {
            helper.scopeHelper.getClonedLocalScope(beforeImportScope);
            helper.command.import(`${secondRemoteName}/comp3`);
            helper.command.importComponent('comp2');
          });
          expectToImportProperly();
        });
        describe('importing comp3 and comp2 at the same time', () => {
          before(() => {
            helper.scopeHelper.getClonedLocalScope(beforeImportScope);
            helper.command.import(`${helper.scopes.remote}/comp2 ${secondRemoteName}/comp3`);
          });
          expectToImportProperly();
          it('should be able to tag', () => {
            expect(() => helper.command.tagAllComponents()).to.not.throw();
          });
        });
      });
      // comp1 scope has the old comp3 with 0.0.1, now with a new export of comp1, it imports
      // comp3 again, which now has only 0.0.2 in its origin.
      describe('the remote of comp1 imports the new version of comp3 (via importMany of exporting comp1)', () => {
        before(() => {
          helper.scopeHelper.getClonedLocalScope(beforeImportScope);
          helper.command.import(`${helper.scopes.remote}/comp2 ${secondRemoteName}/comp3`);
          helper.command.tagAllComponents('', '0.0.7'); // tag comp2 with the updated comp3 version - 0.0.7
          helper.command.export();
        });
        it('comp3: should save 0.0.1 of in the orphanedVersions prop on the remote', () => {
          const comp3 = helper.command.catComponent(`${secondRemoteName}/comp3`, helper.scopes.remotePath);
          expect(comp3).to.have.property('orphanedVersions');
          expect(comp3.orphanedVersions).to.have.property('0.0.1');
        });
        it('comp3: should not have 0.0.1 in the versions object, only 0.0.2 on the remote', () => {
          const comp3 = helper.command.catComponent(`${secondRemoteName}/comp3`, helper.scopes.remotePath);
          expect(comp3.versions).not.to.have.property('0.0.1');
          expect(comp3.versions).to.have.property('0.0.2');
        });
        it('comp3: the head should be the same as 0.0.2 not as 0.0.1 on the remote', () => {
          const comp3 = helper.command.catComponent(`${secondRemoteName}/comp3`, helper.scopes.remotePath);
          const hash = comp3.versions['0.0.2'];
          expect(comp3.head === hash);
        });
        it('should not change the remote of comp3', () => {
          const comp3 = helper.command.catComponent(`${secondRemoteName}/comp3`, secondRemotePath);
          expect(comp3).to.not.have.property('orphanedVersions');
          expect(comp3.versions).not.to.have.property('0.0.1');
          expect(comp3.versions).to.have.property('0.0.2');
        });
      });
      describe('re-export comp3 when locally it has orphanedVersions prop', () => {
        before(() => {
          helper.scopeHelper.getClonedLocalScope(beforeImportScope);
          helper.command.import(`${helper.scopes.remote}/comp1 ${secondRemoteName}/comp3`);
          helper.command.tagComponent(`${secondRemoteName}/comp3`, undefined, '0.0.8 --force');
          helper.command.export();
        });
        it('the remote of comp3 should not get this orphanedVersions prop', () => {
          const comp3 = helper.command.catComponent(`${secondRemoteName}/comp3`, secondRemotePath);
          expect(comp3).to.not.have.property('orphanedVersions');
          expect(comp3.versions).not.to.have.property('0.0.1');
          expect(comp3.versions).to.have.property('0.0.8');
        });
      });
    });
  });
});
