# CodeQL bundle action

This action retrofits an existing [CodeQL bundle](https://github.com/github/codeql-action/releases) with additional [CodeQL packs](https://codeql.github.com/docs/codeql-cli/creating-and-working-with-codeql-packs/).
The bundle will be a single deployable artifact containing the CodeQL standard library, the CodeQL standard queries, and any other libraries or queries that are relevant.
Additionally, the CodeQL standard library and standard queries can be customized to consider additional sources, sinks, data-flow/taint steps, sanitizers and barriers.

A custom codeql bundle has the following benefits:

- A single artifact containing the standard queries and other queries of interest.
- A compilation cache for all the included queries resulting in a faster analysis.
- All the included queries can benefit from customizations that improve the coverage of the analysis.

# Usage

The following Action workflow is a minimal example showing how to use this action to create a bundle containing the CodeQL packs listed in `packs` and how to upload it so it can be referenced in a CodeQL analysis workflow.

```yaml
name: Build and release bundle
on:
  workflow_dispatch:

jobs:
  build-and-release:
    runs-on: ubuntu-latest
    name: Build and release bundle
    steps:
      - name: Checkout
        uses: actions/checkout@v2

      - name: CodeQL bundle
        id: codeql-bundle
        uses: advanced-security/codeql-bundle-action@v1
        with:
          # CodeQL packs that are available in the current repository
          packs: "octo-org/java-lib,octo-org/java-queries,octo-org/java-customizations"

      - name: Bundle release
        env:
          BUNDLE_PATH: ${{ steps.codeql-bundle.outputs.bundle-path }}
          BUNDLE_TAG: ${{ steps.codeql-bundle.outputs.bundle-tag }}
          GITHUB_TOKEN: ${{ github.token }}
        run: |
          if gh release view $BUNDLE_TAG; then
            gh release upload --clobber $BUNDLE_TAG $BUNDLE_PATH
          else
            gh release create $BUNDLE_TAG $BUNDLE_PATH --generate-notes
          fi
```

The following Action workflow excerpt shows how a custom bundle can be used in a CodeQL analysis workflow:

```yaml
    - name: Download benchmark bundle
        env:
          GITHUB_TOKEN: ${{ secrets.PAT }}
        run: |
          gh release download -R octo-org/codeql-bundle --pattern 'codeql-bundle.tar.gz'
        
    - name: CodeQL Initialize
        uses: github/codeql-action/init@v1
        with:
          tools: codeql-bundle.tar.gz
```

## Locating your CodeQL packs

The action relies on a CodeQL Workspace to resolve the location of the specified CodeQL packs.
A CodeQL Workspace can be defined using a `codeql-workspace.yml` file that should contain a key `provide` with an array of locations to your CodeQL packs (i.e., the location of the `qlpack.yml` files).

For an example you can consult the test [CodeQL Workspace](test/qlpacks/codeql-workspace.yml)

By default the action looks at the root of the repository. If the CodeQL Workspace specification is located in a subfolder then you can use the `workspace` input to specify its location.

# Customizations

The CodeQL standard library can be customized by adding implementations of available extension points to a special CodeQL library called `Customizations.qll` that is available for most of the languages (this is not available for C++).
This action uses that mechanism to inject customizations defined in a so called CodeQL customization pack.

A CodeQL customization pack is a concept that doesn't exists outside this action and consists of a CodeQL library pack with extra meta information and structure.
To create a CodeQL customization pack follow these steps:

1. Initialize a new qlpack using the CodeQL CLI as follows (we use Java as an example target): `codeql pack init --version=0.0.1 --extractor java octo-org/java-customizations`
2. Change the value of `library` to `true` in the generated file `java-customizations/qlpack.yml`
3. Create the CodeQL module `java-customizations/octo_org/java_customizations/Customizations.qll` **Note: the directory structure contains the scope and name where the characters `-` are substituted with `_`!**
4. Add the Java standard library as a dependency for development of the customizations using the CodeQL CLI as follows: `codeql pack add --dir=java-customizations codeql/java-all` **Note: ensure the version is compatible with the CodeQL bundle being targeted!**

You can now add your customizations directly in the `Customizations.qll` or other modules that are imported by the `Customizations.qll`.
For examples see our test cases for [Ruby](test/qlpacks/contoso/ruby-customizations/contoso/ruby_customizations/Customizations.qll) and [Java](test/qlpacks/contoso/java-customizations/contoso/java_customizations/Customizations.qll)

# Performance

The creation of a bundle includes the compilation of added CodeQL query packs as well as CodeQL query packs relying on a CodeQL library pack that has been customized.
Depending on the amount of packs that need to be compiled this can be resource intensive.
By default we only process two CodeQL packs concurrently. However, if a machine with better specs is available this limitation can be increased by setting the `concurrency-limit` value.
An indication of resource contention on the Action runner is when the action fails with the CodeQL CLI exiting with a `null` return value.
This indicates the process has been killed by the operating system (this has been only observed for Linux).

# Limitations

This action supports all the languages in the targeted bundle that provides a `Customizations.qll` module.
For the latest bundle this should be all languages except for C++.
