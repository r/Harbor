/**
 * GitHub Awesome list provider.
 * 
 * Fetches server listings from the awesome-mcp-servers README.
 */

import { log } from '../native-messaging.js';
import { CatalogServer } from '../types.js';
import { CatalogProvider, ProviderResult, generateServerId } from './base.js';

const AWESOME_URL = 'https://raw.githubusercontent.com/wong2/awesome-mcp-servers/main/README.md';

// Regex to match markdown links: [text](url) or **[text](url)**
const LINK_REGEX = /\*{0,2}\[([^\]]+)\]\(([^)]+)\)\*{0,2}/g;

export class GitHubAwesomeProvider extends CatalogProvider {
  get id(): string {
    return 'github_awesome';
  }

  get name(): string {
    return 'GitHub Awesome List';
  }

  async fetch(query?: string): Promise<ProviderResult> {
    try {
      log(`[${this.name}] Fetching: ${AWESOME_URL}`);
      
      const response = await fetch(AWESOME_URL);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const markdown = await response.text();
      const servers = this.parseMarkdown(markdown);

      // If query provided, filter results
      let filtered = servers;
      if (query) {
        const q = query.toLowerCase();
        filtered = servers.filter(s => 
          s.name.toLowerCase().includes(q) || 
          s.description.toLowerCase().includes(q)
        );
      }

      log(`[${this.name}] Parsed ${servers.length} servers, returning ${filtered.length}`);
      return this.makeResult(filtered);

    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`[${this.name}] Fetch error: ${message}`);
      return this.makeResult([], message);
    }
  }

  private parseMarkdown(markdown: string): CatalogServer[] {
    const servers: CatalogServer[] = [];
    const lines = markdown.split('\n');
    
    let currentSection = '';
    const seenUrls = new Set<string>();

    for (const line of lines) {
      // Track section headers
      if (line.startsWith('##')) {
        currentSection = line.replace(/^#+\s*/, '').toLowerCase();
        continue;
      }

      // Skip non-list items
      if (!line.trim().startsWith('-') && !line.trim().startsWith('*')) {
        continue;
      }

      // Skip table of contents or navigation sections
      if (currentSection.includes('contents') || currentSection.includes('table')) {
        continue;
      }

      // Extract links from the line
      const matches = [...line.matchAll(LINK_REGEX)];
      if (matches.length === 0) continue;

      // First match is usually the server name/link
      const [, name, url] = matches[0];
      
      // Skip if we've seen this URL
      if (seenUrls.has(url)) continue;
      seenUrls.add(url);

      // Skip non-GitHub/GitLab links (these are usually not MCP servers)
      const isRepo = url.includes('github.com') || url.includes('gitlab.com');
      if (!isRepo) continue;

      // Extract description (rest of the line after the link)
      let description = line;
      // Remove the link markup
      description = description.replace(LINK_REGEX, '');
      // Remove list markers
      description = description.replace(/^[\s\-*]+/, '');
      // Remove separators
      description = description.replace(/^[\s\-–—:]+/, '').trim();
      
      // Check for potential endpoint URL in description
      let endpointUrl = '';
      const httpMatch = description.match(/https?:\/\/[^\s]+/);
      if (httpMatch && !httpMatch[0].includes('github.com') && !httpMatch[0].includes('gitlab.com')) {
        // Found a non-GitHub URL that might be an endpoint
        endpointUrl = httpMatch[0].replace(/[.,;:]+$/, ''); // Remove trailing punctuation
      }

      const tags: string[] = ['installable_only'];
      if (currentSection.includes('official')) {
        tags.push('official');
      }
      if (endpointUrl) {
        tags.push('remote');
        tags.splice(tags.indexOf('installable_only'), 1);
      }

      servers.push({
        id: generateServerId(this.id, url, name),
        name: name.trim(),
        source: this.id,
        endpointUrl,
        installableOnly: !endpointUrl,
        packages: [], // Would need to scrape the repo to get this
        description: description.substring(0, 500), // Limit description length
        homepageUrl: url,
        repositoryUrl: url,
        tags,
        fetchedAt: Date.now(),
      });
    }

    return servers;
  }
}





