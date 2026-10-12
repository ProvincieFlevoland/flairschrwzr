# Schrwzr: how to make a dev build and an acc build

This guide is for developers (CGI, GovChat, other suppliers and Flevoland's own team) working in
the GitHub repository `ProvincieFlevoland/flairschrwzr`. It explains what you do in Git to get
your change running in **dev** and in **acc**. Everything after your Git action is done by the
Azure DevOps pipeline ([`.azuredevops/dev/azure-pipelines.yml`](../.azuredevops/dev/azure-pipelines.yml)). You never build or push
images yourself.

Background and design decisions are in [DESIGN.md](DESIGN.md).

## At a glance

| You want | You do | The pipeline does | Result |
|---|---|---|---|
| Feedback on your change | Open a pull request into `main` (or `release/*`) | Builds and scans the image, pushes nothing | Green or red check on the PR |
| A **dev** build | Merge the PR into `main` (or `release/*`) | Builds, pushes to the dev registry, deploys to dev | Dev runs your commit, version like `2.2.0-main.a1b2c3d` |
| An **acc** build | Create a release tag `vX.Y.Z` | Builds the release image once and deploys it to dev; later the same image goes to acc | Image `X.Y.Z` that cannot be overwritten |

> **Acc is not live yet.** Acc and prod will run in their own Azure subscription with their own
> container registry. Until that exists, a release tag produces the final, locked release image
> and deploys it to dev only. Once acc is set up, the same tag will also promote that exact image
> to acc after an approval. Nothing changes in how you work.

| Environment | Azure | Registry | Container App |
|---|---|---|---|
| dev, also used for testing (TST) | `flv-landingzone-ai-hub-dev` | `acrflvaidev01` | `aca-flair-admin-dev-schrwzr` |
| acc | separate subscription (not created yet) | own ACR (not created yet) | to be decided |

## Branches and versions

* `main` is where the next release is built (currently 2.x).
* `release/1.x` is the maintenance branch for the current stable line. Fixes for 1.x go there.
* Releases are Git tags `vMAJOR.MINOR.PATCH`, for example `v2.2.0` or `v1.4.3`, using
  [semantic versioning](https://semver.org): a patch for fixes, a minor for new features, a major for breaking changes.
* Nobody pushes directly to `main` or `release/*`. All changes go through a pull request that
  needs a review from a Flevoland code owner and a green pipeline check.

## Making a dev build

1. **Create a branch** from `main`, for example `feature/upload-limit` or `fix/login-redirect`.
   For a 1.x fix, branch from `release/1.x` instead.
2. **Build and test locally** if you like:
   ```bash
   docker build -f admin/Dockerfile -t schrwzr-local admin
   docker run --rm -p 3002:3002 schrwzr-local   # then open http://localhost:3002
   ```
3. **Open a pull request** into `main` (or `release/1.x`).
   * The pipeline's Validate stage builds the image and runs a Trivy security scan. It fails on
     critical vulnerabilities that have a fix available.
   * The result appears as a check on the PR. Fix and push again until it is green.
   * PRs from forks only build after a Flevoland team member has approved the run. That is
     expected.
4. **Get a review** from a Flevoland code owner and merge.
5. **The dev build happens automatically:**
   1. Build: the image is built in the dev registry and tagged with a unique version:
      * from `main`: `<next minor>-main.<commit>`, for example `2.2.0-main.a1b2c3d`
      * from `release/1.x`: `<next patch>-rc.<commit>`, for example `1.4.3-rc.a1b2c3d`
   2. Deploy to dev: the dev Container App gets a new revision with exactly that image. The
      pipeline waits until the revision is healthy and runs a smoke test.
6. **Check the result** in Azure DevOps: the run is named after the version. If the deploy
   fails, dev keeps running the previous version, because traffic only moves to a healthy
   revision.

Several merges shortly after each other are combined into one run. Changes that only touch
`docs/`, `*.md` or `.github/` do not start a build.

## User testing

For now there is no separate test environment: users test on **dev** (`aca-flair-admin-dev-schrwzr`).
This may change later.

1. When your change is in dev and you want users to test it, ask them, and give them the
   version from the Azure DevOps run (for example `2.2.0-main.a1b2c3d`).
2. Every merge to `main` deploys to dev straight away and replaces what is running. During a
   test session, agree with the other developers to hold merges, or tell the testers that the
   version will change.
3. If the testers sign off, that commit is the one to tag for acc (see below).

## Making an acc build (release)

A release is cut by a Flevoland maintainer (tag creation is restricted).

1. **Make sure the commit is in dev and tested.** Only tag commits that have already passed a
   dev build.
2. **Create the tag** on that commit, either as a GitHub Release ("Draft a new release", tag
   `v2.2.0`, target `main`) or from the command line:
   ```bash
   git checkout main && git pull
   git tag -a v2.2.0 -m "Release 2.2.0"
   git push origin v2.2.0
   ```
   For a 1.x patch, tag the commit on `release/1.x`, for example `v1.4.3`.
3. **The pipeline builds the release image** and tags it `2.2.0`, plus `2.2` and `2`. The `2.2.0`
   tag is locked in the registry, so it can never point to anything else.
4. **Today:** the release image is deployed to dev, so you can do a final check of exactly what
   will go to acc.
5. **Once acc exists:** the pipeline copies that same image (same digest, no rebuild) into the
   acc registry and deploys it to acc after an approval by Flevoland. Prod follows the same way
   from acc.

A tag cannot be reused. If a release turns out to be broken, fix it and tag the next patch
(`v2.2.1`). Do not delete and recreate a tag.

## Which version is running?

* In Azure DevOps, the latest successful "Deploy TEST" run shows the version.
* In the app, the `SOFTWARE_VERSION_TAG` environment variable holds the version.
* From the command line (with read access):
  ```bash
  az containerapp show -n aca-flair-admin-dev-schrwzr -g <resource-group> \
    --query "properties.template.containers[0].image" -o tsv
  az acr repository show-tags -n acrflvaidev01 --repository govchat-adminoverlay --orderby time_desc --top 10 -o table
  ```

## Rolling back dev

Open an earlier successful run in Azure DevOps and re-run its **Deploy TEST** stage. That deploys
the image digest of that run again. No rebuild is needed.

## Good to know

* **Weekly rebuild.** Every Monday at 03:00 UTC, `main` and `release/*` are rebuilt to pick up
  security patches in the base image, and deployed to dev. These versions end in `-r<build id>`.
* **No manual pushes.** Do not push images to the registry by hand, and do not use `latest`.
  Every environment runs an exact image digest built by the pipeline.
* **Manual runs.** "Run pipeline" in Azure DevOps on `main` or `release/*` does the same as a merge.
  Do not run it on a feature branch: that would deploy unreviewed code to dev.
* **Pipeline changes** go through a PR like any other code, because Azure DevOps reads
  `.azuredevops/dev/azure-pipelines.yml` from the commit it builds.
