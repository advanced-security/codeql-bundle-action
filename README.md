# CodeQL bundle action

This action retrofits an existing [CodeQL bundle](https://github.com/github/codeql-action/releases) with additional [CodeQL packs](https://codeql.github.com/docs/codeql-cli/creating-and-working-with-codeql-packs/) using the [CodeQL bundle CLI](https://github.com/rvermeulen/codeql-bundle)
The bundle will be a single deployable artifact containing the CodeQL standard library, the CodeQL standard queries, and any other libraries or queries that are relevant.
Additionally, the CodeQL standard library and standard queries can be customized to consider additional sources, sinks, data-flow/taint steps, sanitizers and barriers.

A custom codeql bundle has the following benefits:

- A single artifact containing the standard queries and other queries of interest.
- A compilation cache for all the included queries resulting in a faster analysis.
- All the included queries can benefit from customizations that improve the coverage of the analysis.

## Usage

The following Action workflow is a minimal example showing how to use this action to create a bundle containing the CodeQL packs listed in `packs` and how to upload it as an artifact.

```yaml
name: "Build custom bundle"
on:
  push:
    branches:
      - main
  pull_request:
    branches:
      - main
  workflow_dispatch:

jobs:
  test:
    name: "Create custom bundle"
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: advanced-security/codeql-bundle-action/download-bundle@v2
        id: download-bundle
        with:
          tag: "latest"
      - uses: advanced-security/codeql-bundle-action/create-bundle@v2
        id: create-bundle
        with:
          bundle-path: ${{ steps.download-bundle.outputs.bundle-path }}
          packs: "octo/cpp-queries,octo/cpp-all,octo/cpp-customizations" 
      - uses: actions/upload-artifact@v3
        with:
          name: codeql-bundle.tar.gz
          path: ${{ steps.create-bundle.outputs.output-path }}
```

The following Action workflow excerpt shows how a custom bundle can be used in a CodeQL analysis workflow.
It assumes the custom bundle is available as a release, but any other location works as long as it is made
available before the `github/codeql-action/init` step and its path is made available to the `tools` input.

```yaml
    - name: Download benchmark bundle
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          gh release download -R octo-org/codeql-bundle --pattern 'codeql-bundle.tar.gz'
        
    - name: CodeQL Initialize
        uses: github/codeql-action/init@v2
        with:
          tools: codeql-bundle.tar.gz
```

## Locating your CodeQL packs

The action relies on a CodeQL Workspace to resolve the location of the specified CodeQL packs.
A CodeQL Workspace can be defined using a `codeql-workspace.yml` file that should contain a key `provide` with an array of locations to your CodeQL packs (i.e., the location of the `qlpack.yml` files).

For an example you can consult the test [CodeQL Workspace](tests/codeql-workspace.yml)

By default the action looks at the root of the repository. If the CodeQL Workspace specification is located in a subfolder then you can use the `workspace` input to specify its location.

## Customizations

The CodeQL standard library can be customized by adding implementations of available extension points to a special CodeQL library called `Customizations.qll` that is available for most of the languages (this is not available for C++).
This action uses that mechanism to inject customizations defined in a so called CodeQL customization pack.

A CodeQL customization pack is a concept that doesn't exists outside this action and consists of a CodeQL library pack with extra meta information and structure.
To create a CodeQL customization pack follow these steps:

1. Initialize a new qlpack using the CodeQL CLI as follows (we use Java as an example target): `codeql pack init octo/java-customizations`
2. Change the value of `library` to `true` in the generated file `java-customizations/qlpack.yml`
3. Create the CodeQL module `java-customizations/octo/java_customizations/Customizations.qll` **Note: the directory structure contains the scope and name where the characters `-` are substituted with `_`!**
4. Add the Java standard library as a dependency for development of the customizations using the CodeQL CLI as follows: `codeql pack add --dir=java-customizations codeql/java-all` **Note: ensure the version is compatible with the CodeQL bundle being targeted!**

You can now add your customizations directly in the `Customizations.qll` or other modules that are imported by the `Customizations.qll`.

## Creating platform specific bundles

By default the `download-action` uses the platform agnostic CodeQL bundle that supports all the platforms supported by the CodeQL CLI.
To reduce the size of the final artifact you can use a platform specific bundle by specifying the `platforms` input with one of `osx64`, `linux64`, or `win64`.
Note that the runner **MUST** be compatible with the platform!

The `create-bundle` is capable of building platform specific CodeQL bundles from the platform agnostic bundle.
It will build a bundle for each of the platforms provided in the `platforms` input.

This combination provides the flexibility to build bundles for platforms that are not supported by the Action runner.
For example, the following workflow creates separate bundles for each platform.

```yaml
name: "Build custom bundle"
on:
  push:
    branches:
      - main
  pull_request:
    branches:
      - main
  workflow_dispatch:

jobs:
  test:
    name: "Create custom bundle"
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: advanced-security/codeql-bundle-action/download-bundle@v2
        id: download-bundle
        with:
          tag: "latest"
      - uses: advanced-security/codeql-bundle-action/create-bundle@v2
        id: create-bundle
        with:
          bundle-path: ${{ steps.download-bundle.outputs.bundle-path }}
          packs: "octo/cpp-queries,octo/cpp-all,octo/cpp-customizations"
          platforms: osx64,win64,linux64
      - uses: actions/upload-artifact@v3
        with:
          name: codeql-bundles
          path: ${{ steps.create-bundle.outputs.output-path }}
```

When providing multiple platforms the `output-path` output is a directory containing the bundles, each named according to pattern `codeql-bundle-$PLATFORM.tar.gz`.

## Limitations

This Action uses the [CodeQL bundle CLI](https://github.com/rvermeulen/codeql-bundle) and inherits its limitations.
