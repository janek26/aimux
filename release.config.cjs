const repositoryUrl = process.env.GITHUB_REPOSITORY
  ? `${process.env.GITHUB_SERVER_URL ?? "https://github.com"}/${process.env.GITHUB_REPOSITORY}.git`
  : undefined;

module.exports = {
  branches: ["main"],
  ...(repositoryUrl ? { repositoryUrl } : {}),
  plugins: [
    "@semantic-release/commit-analyzer",
    "@semantic-release/release-notes-generator",
    "@semantic-release/npm",
    [
      "@semantic-release/github",
      {
        failComment: false,
      },
    ],
  ],
};
