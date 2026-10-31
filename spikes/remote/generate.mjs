import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(new URL('./packages/dsh-bot-spike-remote/package.json', import.meta.url));
const { WorkspaceTypertGenerator, writeWorkspaceArtifacts } = await import(require.resolve('@deepseek-ai/dsh-typert-generator'));
const root = fileURLToPath(new URL('.', import.meta.url));
const artifacts = new WorkspaceTypertGenerator(root).generateContributors(['host']);
if (artifacts.length !== 1 || !artifacts[0].remote) throw new Error('Expected one generated Remote contribution');
writeWorkspaceArtifacts(root, artifacts);
console.log('PASS generated third-party Host/Client Typert artifacts');
