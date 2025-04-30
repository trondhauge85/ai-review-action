const core = require('@actions/core');
const github = require('@actions/github');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { execSync } = require('child_process'); // To run git commands
const minimatch = require('minimatch'); // Import minimatch

// Helper function to filter diff based on ignore patterns
function filterDiffByIgnorePatterns(diff, ignorePatterns) {
  if (!ignorePatterns || ignorePatterns.length === 0) {
    core.info('No ignore patterns provided, skipping filtering.');
    return diff;
  }
  if (!diff) return '';

  core.info(`Filtering diff based on ${ignorePatterns.length} ignore patterns...`);
  const diffChunks = diff.split('\ndiff --git ');
  const filteredChunks = [];
  let headerSkipped = false; // Handle potential empty first chunk

  for (let i = 0; i < diffChunks.length; i++) {
    let chunk = diffChunks[i];
    if (i === 0 && !chunk.startsWith('diff --git')) {
       if (chunk.trim() === '') {
           headerSkipped = true;
           continue;
       }
       core.warning('Diff chunk 0 does not start with "diff --git", including it without pattern check.');
       filteredChunks.push(chunk);
       continue;
    }

    // Add the delimiter back
    if (i > 0 || !headerSkipped) {
        chunk = 'diff --git ' + chunk;
    }

    // Extract the 'b/' path
    const headerMatch = chunk.match(/^diff --git a\/(?:.*?) b\/(.+?)(?:\n|$)/);
    if (!headerMatch || !headerMatch[1]) {
      core.warning(`Could not parse file path from diff header in chunk ${i}, including chunk:\n${chunk.substring(0, 100)}...`);
      filteredChunks.push(chunk);
      continue;
    }

    const filePathB = headerMatch[1].trim();

    // Check if it's a deleted file (b path is /dev/null) - always keep deleted file diffs
    if (filePathB === '/dev/null') {
      const filePathA = chunk.match(/^diff --git a\/(.+?) b\//)?.[1];
      core.debug(`Keeping chunk for deleted file: ${filePathA || 'unknown'}`);
      filteredChunks.push(chunk);
      continue;
    }

    // Check against ignore patterns
    let isIgnored = false;
    for (const pattern of ignorePatterns) {
      // Use { dot: true } to allow matching hidden files/dirs like .github
      if (minimatch(filePathB, pattern, { dot: true })) {
        core.info(`Excluding diff chunk for ignored file matching pattern "${pattern}": ${filePathB}`);
        isIgnored = true;
        break; // Stop checking patterns for this file
      }
    }

    if (!isIgnored) {
      core.debug(`Keeping chunk for file: ${filePathB}`);
      filteredChunks.push(chunk);
    }
  }

  const filteredDiff = filteredChunks.join('\n');
  core.info(`Original diff length: ${diff.length}, Filtered diff length: ${filteredDiff.length}`);
  return filteredDiff;
}

async function run() {
  try {
    // --- Get Inputs ---
    const token = core.getInput('github-token', { required: true });
    const geminiApiKey = core.getInput('gemini-api-key', { required: true });
    const geminiModel = core.getInput('gemini-model', { required: false }) || 'gemini-1.5-flash';
    const ignorePatternsInput = core.getInput('ignore-patterns', { required: false }) || '';
    // Split multiline input into an array of patterns, trimming whitespace and removing empty lines
    const ignorePatterns = ignorePatternsInput.split('\n')
                                             .map(p => p.trim())
                                             .filter(p => p !== '');

    // --- Get GitHub Context ---
    const octokit = github.getOctokit(token);
    const context = github.context;

    if (context.eventName !== 'pull_request') {
      core.setFailed('This action only works on pull_request events.');
      return;
    }

    const pr = context.payload.pull_request;
    if (!pr) {
      core.setFailed('Could not get pull request context.');
      return;
    }
    const prNumber = pr.number;
    const owner = context.repo.owner;
    const repo = context.repo.repo;
    const baseRef = pr.base.ref;
    const headSha = pr.head.sha;

    core.info(`Processing PR #${prNumber} in ${owner}/${repo}`);
    core.info(`Base ref: ${baseRef}, Head SHA: ${headSha}`);

    // --- Get Diff ---
    core.info('Fetching base ref and getting diff...');
    let fullDiffContent = '';
    const execOptions = {
      maxBuffer: 50 * 1024 * 1024,
      stdio: 'pipe'
    };
    try {
      execSync(`git fetch origin ${baseRef} --depth=1`, { stdio: 'inherit' });
      fullDiffContent = execSync(`git diff origin/${baseRef}...${headSha}`, execOptions).toString();
    } catch (error) {
      core.warning(`Could not fetch base ref or get diff: ${error.message}. Trying diff against merge base...`);
      try {
        const mergeBase = execSync(`git merge-base origin/${baseRef} ${headSha}`).toString().trim();
        fullDiffContent = execSync(`git diff ${mergeBase} ${headSha}`, execOptions).toString();
      } catch (fallbackError) {
         core.setFailed(`Failed to get diff: ${fallbackError.message}`);
         return;
      }
    }

    if (!fullDiffContent || fullDiffContent.trim() === '') {
      core.info('No diff found. Skipping review.');
      return;
    }
    core.info(`Full diff obtained (${fullDiffContent.length} characters).`);

    // --- Filter Diff by Ignore Patterns ---
    let diffContent = filterDiffByIgnorePatterns(fullDiffContent, ignorePatterns);

    if (!diffContent || diffContent.trim() === '') {
      core.info('Diff is empty after filtering. Skipping review.');
      return;
    }
    core.info(`Final diff size after filtering: ${diffContent.length} characters.`);


    // Optional: Truncate diff if too long for the API (apply AFTER filtering)
    const MAX_DIFF_LENGTH = 30000; // Adjust as needed
     if (diffContent.length > MAX_DIFF_LENGTH) {
       core.warning(`Filtered diff content is still long (${diffContent.length} chars), truncating to ${MAX_DIFF_LENGTH} chars.`);
       diffContent = diffContent.substring(0, MAX_DIFF_LENGTH) + "\n\n... (diff truncated)";
     }


    // --- Call Gemini API ---
    core.info(`Initializing Gemini with model ${geminiModel}...`);
    const genAI = new GoogleGenerativeAI(geminiApiKey);
    const model = genAI.getGenerativeModel({ model: geminiModel });

    const prompt = `
Act as an expert code reviewer for a GitHub pull request.
Analyze the following code changes provided in the git diff format below.
NOTE: Diffs for files matching specific ignore patterns (e.g., build outputs, lock files) may have been excluded.
Provide constructive feedback focusing on:
- Potential bugs, logic errors, or edge cases.
- Security vulnerabilities or concerns.
- Performance optimizations or bottlenecks.
- Code style, readability, and maintainability improvements according to standard conventions.
- Adherence to best practices.

Format your response in Markdown.
Be concise and clear. If there are no major issues, state that clearly.
Do not include the diff itself in your response. Start the review directly.

Git Diff:
\`\`\`diff
${diffContent}
\`\`\`
`;

    let reviewText = '';
    try {
      core.info('Sending request to Gemini API...');
      const result = await model.generateContent(prompt);
      // Adjust access based on actual SDK response structure
      if (result.response && result.response.candidates && result.response.candidates.length > 0 &&
          result.response.candidates[0].content && result.response.candidates[0].content.parts &&
          result.response.candidates[0].content.parts.length > 0) {
         reviewText = result.response.candidates[0].content.parts[0].text;
         core.info('Received review from Gemini.');
      } else {
         core.warning('Gemini response structure unexpected or empty.');
         console.log('Full Gemini Response:', JSON.stringify(result, null, 2)); // Log the full response for debugging
         reviewText = 'AI review could not be generated (unexpected response structure).';
      }

    } catch (error) {
      core.error(`Error calling Gemini API: ${error}`);
      if (error.message && error.message.includes('API key not valid')) {
        core.setFailed('Gemini API Key is invalid. Please check the GEMINI_API_KEY secret.');
      } else {
        core.setFailed(`Failed to get review from Gemini: ${error.message}`);
      }
      return; // Stop execution if API call fails
    }

    if (!reviewText || reviewText.trim() === '') {
      core.info('Gemini returned an empty review. Skipping comment posting.');
      return;
    }

    // --- Post Comment to PR ---
    core.info('Posting review comment to PR...');
    const MAX_COMMENT_LENGTH = 65536; // GitHub API limit
    let commentBody = `**✨ AI Code Review by Gemini (${geminiModel}) ✨**\n\n${reviewText}`;

    if (commentBody.length > MAX_COMMENT_LENGTH) {
      core.warning(`Review comment exceeds GitHub's maximum length (${MAX_COMMENT_LENGTH} characters). Truncating.`);
      commentBody = commentBody.substring(0, MAX_COMMENT_LENGTH - 100) + "\n\n...(comment truncated due to length)";
    }

    try {
      await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: prNumber,
        body: commentBody,
      });
      core.info('Review comment posted successfully.');
    } catch (error) {
      core.setFailed(`Failed to post review comment: ${error.message}`);
    }

  } catch (error) {
    core.setFailed(`Action failed: ${error.message}`);
     if (error.stack) {
       core.error(error.stack);
     }
  }
}

run();
