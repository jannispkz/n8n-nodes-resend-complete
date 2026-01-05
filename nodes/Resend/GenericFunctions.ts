import {
	IExecuteFunctions,
	ILoadOptionsFunctions,
	INodePropertyOptions,
	NodeOperationError,
} from 'n8n-workflow';

export type ListOptions = {
	after?: string;
	before?: string;
};

export const normalizeEmailList = (value: string | string[] | undefined) => {
	if (Array.isArray(value)) {
		return value
			.map((email) => String(email).trim())
			.filter((email) => email);
	}
	if (typeof value === 'string') {
		return value
			.split(',')
			.map((email) => email.trim())
			.filter((email) => email);
	}
	return [];
};

export const parseTemplateVariables = (
	executeFunctions: IExecuteFunctions,
	variablesInput: { variables?: Array<{ key: string; type: string; fallbackValue?: unknown }> } | undefined,
	fallbackKey: 'fallbackValue' | 'fallback_value',
	itemIndex: number,
) => {
	if (!variablesInput?.variables?.length) {
		return undefined;
	}

	return variablesInput.variables.map((variable) => {
		const variableEntry: Record<string, unknown> = {
			key: variable.key,
			type: variable.type,
		};

		const fallbackValue = variable.fallbackValue;
		if (fallbackValue !== undefined && fallbackValue !== '') {
			let parsedFallback: string | number = fallbackValue as string;
			if (variable.type === 'number') {
				const numericFallback = typeof fallbackValue === 'number' ? fallbackValue : Number(fallbackValue);
				if (Number.isNaN(numericFallback)) {
					throw new NodeOperationError(
						executeFunctions.getNode(),
						`Variable "${variable.key}" fallback value must be a number`,
						{ itemIndex },
					);
				}
				parsedFallback = numericFallback;
			}
			variableEntry[fallbackKey] = parsedFallback;
		}

		return variableEntry;
	});
};

export const buildTemplateSendVariables = (
	variablesInput: { variables?: Array<{ key: string; value?: unknown }> } | undefined,
) => {
	if (!variablesInput?.variables?.length) {
		return undefined;
	}
	const variables: Record<string, unknown> = {};
	for (const variable of variablesInput.variables) {
		if (!variable.key) {
			continue;
		}
		variables[variable.key] = variable.value ?? '';
	}

	return Object.keys(variables).length ? variables : undefined;
};

export const requestList = async (
	executeFunctions: IExecuteFunctions,
	url: string,
	listOptions: ListOptions,
	apiKey: string,
	itemIndex: number,
	returnAll: boolean,
	limit?: number,
) => {
	if (listOptions.after && listOptions.before) {
		throw new NodeOperationError(
			executeFunctions.getNode(),
			'You can only use either "After" or "Before", not both.',
			{ itemIndex },
		);
	}

	const shouldReturnAll = returnAll === true;
	const qs: Record<string, string | number> = {};
	const pageSize = shouldReturnAll ? 100 : (limit ?? 50);

	if (pageSize !== undefined) {
		qs.limit = pageSize;
	}
	if (listOptions.after) {
		qs.after = listOptions.after;
	}
	if (listOptions.before) {
		qs.before = listOptions.before;
	}

	const requestPage = () =>
		executeFunctions.helpers.httpRequest({
			url,
			method: 'GET',
			headers: {
				Authorization: `Bearer ${apiKey}`,
			},
			qs,
			json: true,
		});

	if (!shouldReturnAll) {
		const singleResponse = await requestPage();
		if (
			typeof limit === 'number' &&
			limit > 0 &&
			Array.isArray((singleResponse as { data?: unknown[] }).data)
		) {
			const responseData = (singleResponse as { data?: unknown[] }).data ?? [];
			if (responseData.length > limit) {
				(singleResponse as { data: unknown[] }).data = responseData.slice(0, limit);
			}
		}
		return singleResponse;
	}

	const allItems: unknown[] = [];
	let lastResponse: unknown;
	let hasMore = true;
	let pageCount = 0;
	const maxPages = 100;
	let paginationMode: 'after' | 'before' | undefined = listOptions.before ? 'before' : undefined;

	while (hasMore) {
		lastResponse = await requestPage();
		const responseData = Array.isArray((lastResponse as { data?: unknown[] }).data)
			? ((lastResponse as { data?: unknown[] }).data as unknown[])
			: [];
		allItems.push(...responseData);

		hasMore = Boolean((lastResponse as { has_more?: boolean }).has_more);
		pageCount += 1;
		if (!hasMore || responseData.length === 0 || pageCount >= maxPages) {
			break;
		}

		const lastItem = responseData[responseData.length - 1] as { id?: string } | undefined;
		if (!lastItem?.id) {
			break;
		}

		if (paginationMode === 'before') {
			qs.before = lastItem.id;
			delete qs.after;
		} else {
			qs.after = lastItem.id;
			delete qs.before;
			paginationMode = 'after';
		}
	}

	if (lastResponse && Array.isArray((lastResponse as { data?: unknown[] }).data)) {
		(lastResponse as { data: unknown[] }).data = allItems;
		(lastResponse as { has_more?: boolean }).has_more = false;
		return lastResponse;
	}

	return { object: 'list', data: allItems, has_more: false };
};

export async function getTemplateVariables(
	this: ILoadOptionsFunctions,
): Promise<INodePropertyOptions[]> {
	const getStringValue = (value: unknown) =>
		typeof value === 'string' && value.trim() ? value : undefined;
	const safeGet = (getter: () => unknown) => {
		try {
			return getter();
		} catch {
			return undefined;
		}
	};
	const getParameterValue = (name: string) => {
		const currentParameters = this.getCurrentNodeParameters();
		const fromCurrentParameters = getStringValue(currentParameters?.[name]);
		if (fromCurrentParameters) {
			return fromCurrentParameters;
		}

		const fromCurrentNodeParameter = getStringValue(
			safeGet(() => this.getCurrentNodeParameter(name)),
		);
		if (fromCurrentNodeParameter) {
			return fromCurrentNodeParameter;
		}

		const fromNodeParameter = getStringValue(safeGet(() => this.getNodeParameter(name, '')));
		if (fromNodeParameter) {
			return fromNodeParameter;
		}

		return undefined;
	};

	const templateId = getParameterValue('emailTemplateId') ?? getParameterValue('templateId');
	if (!templateId) {
		return [];
	}
	const normalizedTemplateId = templateId.trim();
	if (normalizedTemplateId.startsWith('={{') || normalizedTemplateId.includes('{{')) {
		return [];
	}

	const credentials = await this.getCredentials('resendApi');
	const apiKey = credentials.apiKey as string;

	const response = await this.helpers.httpRequest({
		url: `https://api.resend.com/templates/${encodeURIComponent(templateId)}`,
		method: 'GET',
		headers: {
			Authorization: `Bearer ${apiKey}`,
		},
		json: true,
	});

	const variables = response?.variables ?? [];

	return variables
		.filter((variable: { key?: string }) => variable?.key)
		.map((variable: { key: string; type?: string }) => {
			const typeLabel = variable.type ? ` (${variable.type})` : '';
			return {
				name: `${variable.key}${typeLabel}`,
				value: variable.key,
			};
		});
}

export async function getTemplates(
	this: ILoadOptionsFunctions,
): Promise<INodePropertyOptions[]> {
	const credentials = await this.getCredentials('resendApi');
	const apiKey = credentials.apiKey as string;
	const returnData: INodePropertyOptions[] = [];
	const limit = 100;
	let after: string | undefined;
	let hasMore = true;
	let pageCount = 0;
	const maxPages = 10;

	while (hasMore) {
		const qs: Record<string, string | number> = { limit };
		if (after) {
			qs.after = after;
		}

		const response = await this.helpers.httpRequest({
			url: 'https://api.resend.com/templates',
			method: 'GET',
			headers: {
				Authorization: `Bearer ${apiKey}`,
			},
			qs,
			json: true,
		});

		const templates = response?.data ?? [];
		for (const template of templates) {
			if (!template?.id) {
				continue;
			}
			const name = template.name ? `${template.name} (${template.id})` : template.id;
			returnData.push({
				name,
				value: template.id,
			});
		}

		hasMore = Boolean(response?.has_more);
		after = templates.length ? templates[templates.length - 1].id : undefined;
		pageCount += 1;
		if (!after || pageCount >= maxPages) {
			break;
		}
	}

	return returnData;
}

export async function getSegments(
	this: ILoadOptionsFunctions,
): Promise<INodePropertyOptions[]> {
	const credentials = await this.getCredentials('resendApi');
	const apiKey = credentials.apiKey as string;
	const returnData: INodePropertyOptions[] = [];
	const limit = 100;
	let after: string | undefined;
	let hasMore = true;
	let pageCount = 0;
	const maxPages = 10;

	while (hasMore) {
		const qs: Record<string, string | number> = { limit };
		if (after) {
			qs.after = after;
		}

		const response = await this.helpers.httpRequest({
			url: 'https://api.resend.com/segments',
			method: 'GET',
			headers: {
				Authorization: `Bearer ${apiKey}`,
			},
			qs,
			json: true,
		});

		const segments = response?.data ?? [];
		for (const segment of segments) {
			if (!segment?.id) {
				continue;
			}
			const name = segment.name ? `${segment.name} (${segment.id})` : segment.id;
			returnData.push({
				name,
				value: segment.id,
			});
		}

		hasMore = Boolean(response?.has_more);
		after = segments.length ? segments[segments.length - 1].id : undefined;
		pageCount += 1;
		if (!after || pageCount >= maxPages) {
			break;
		}
	}

	return returnData;
}

export async function getTopics(
	this: ILoadOptionsFunctions,
): Promise<INodePropertyOptions[]> {
	const credentials = await this.getCredentials('resendApi');
	const apiKey = credentials.apiKey as string;
	const returnData: INodePropertyOptions[] = [];
	const limit = 100;
	let after: string | undefined;
	let hasMore = true;
	let pageCount = 0;
	const maxPages = 10;

	while (hasMore) {
		const qs: Record<string, string | number> = { limit };
		if (after) {
			qs.after = after;
		}

		const response = await this.helpers.httpRequest({
			url: 'https://api.resend.com/topics',
			method: 'GET',
			headers: {
				Authorization: `Bearer ${apiKey}`,
			},
			qs,
			json: true,
		});

		const topics = response?.data ?? [];
		for (const topic of topics) {
			if (!topic?.id) {
				continue;
			}
			const name = topic.name ? `${topic.name} (${topic.id})` : topic.id;
			returnData.push({
				name,
				value: topic.id,
			});
		}

		hasMore = Boolean(response?.has_more);
		after = topics.length ? topics[topics.length - 1].id : undefined;
		pageCount += 1;
		if (!after || pageCount >= maxPages) {
			break;
		}
	}

	return returnData;
}
