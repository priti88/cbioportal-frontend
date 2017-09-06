import {
    DiscreteCopyNumberFilter, DiscreteCopyNumberData, ClinicalData, ClinicalDataMultiStudyFilter, Sample,
    SampleIdentifier, MolecularProfile, Mutation, GeneMolecularData, MolecularDataFilter
} from "shared/api/generated/CBioPortalAPI";
import client from "shared/api/cbioportalClientInstance";
import {computed, observable, action} from "mobx";
import {remoteData, addErrorHandler} from "shared/api/remoteData";
import {labelMobxPromises, cached} from "mobxpromise";
import OncoKbEvidenceCache from "shared/cache/OncoKbEvidenceCache";
import PubMedCache from "shared/cache/PubMedCache";
import CancerTypeCache from "shared/cache/CancerTypeCache";
import MutationCountCache from "shared/cache/MutationCountCache";
import DiscreteCNACache from "shared/cache/DiscreteCNACache";
import PdbHeaderCache from "shared/cache/PdbHeaderCache";
import {
    findMolecularProfileIdDiscrete, fetchMyCancerGenomeData,
    fetchDiscreteCNAData, findMutationMolecularProfileId, mergeDiscreteCNAData,
    fetchSamples, fetchClinicalDataInStudy, generateDataQueryFilter,
    fetchSamplesWithoutCancerTypeClinicalData, fetchStudiesForSamplesWithoutCancerTypeClinicalData, IDataQueryFilter,
    isMutationProfile
} from "shared/lib/StoreUtils";
import {MutationMapperStore} from "./mutation/MutationMapperStore";
import AppConfig from "appConfig";
import * as _ from 'lodash';
import {stringListToSet} from "../../shared/lib/StringUtils";
import {toSampleUuid} from "../../shared/lib/UuidUtils";
import MutationDataCache from "../../shared/cache/MutationDataCache";
import accessors from "../../shared/lib/oql/accessors";
import {filterCBioPortalWebServiceData} from "../../shared/lib/oql/oqlfilter";
import {keepAlive} from "mobx-utils";

export type SamplesSpecificationElement = { studyId:string, sampleId:string, sampleListId:undefined } |
                                    { studyId:string, sampleId:undefined, sampleListId:string};

export class ResultsViewPageStore {

    constructor() {
        labelMobxPromises(this);

        addErrorHandler((error:any) => {
            this.ajaxErrors.push(error);
        });
    }

    @observable public urlValidationError: string | null = null;

    @observable ajaxErrors: Error[] = [];

    @observable hugoGeneSymbols: string[]|null = null;
    @observable samplesSpecification:SamplesSpecificationElement[] = [];

    @observable zScoreThreshold: number;

    @observable rppaScoreThreshold: number;

    @observable oqlQuery: string = '';

    @observable selectedMolecularProfileIds: string[] = [];

    readonly selectedGeneticProfiles = remoteData(() => {
        return Promise.all(this.selectedMolecularProfileIds.map((id) => client.getMolecularProfileUsingGET({molecularProfileId: id})));
    });

    //NOTE: this can only be invoked after mutationMapperStores is populated.  not great.
    readonly allMutations = remoteData({
        await: () =>
            _.flatMap(this.mutationMapperStores, (store: MutationMapperStore) => store.mutationData)
        ,
        invoke: async() => {
            return _.mapValues(this.mutationMapperStores, (store: MutationMapperStore) => store.mutationData.result);
        }
    });

    readonly geneticData = remoteData({
        await: () => [
            this.studyToDataQueryFilter,
            this.genes,
            this.selectedGeneticProfiles
        ],
        invoke: async() => {
            // we get mutations with mutations endpoint, all other alterations with this one, so filter out mutation genetic profile
            const profilesWithoutMutationProfile = _.filter(this.selectedGeneticProfiles.result, (profile: MolecularProfile) => profile.molecularAlterationType !== 'MUTATION_EXTENDED');
            if (profilesWithoutMutationProfile) {
                const promises:Promise<GeneMolecularData[]>[] = profilesWithoutMutationProfile.map((profile: MolecularProfile) => {
                    const filter:MolecularDataFilter = (Object.assign(
                            {},
                            {
                                entrezGeneIds:this.genes.result!.map(gene => gene.entrezGeneId)
                            },
                            this.studyToDataQueryFilter.result![profile.studyId]
                        ) as MolecularDataFilter
                    );
                    return client.fetchAllMolecularDataInMolecularProfileUsingPOST({
                        molecularProfileId: profile.molecularProfileId,
                        molecularDataFilter: filter,
                        projection: 'DETAILED'
                    });
                });
                return Promise.all(promises).then((arrs: GeneMolecularData[][]) => _.concat([],...arrs));
            } else {
                return [];
            }
        }
    });

    readonly filteredAlterations = remoteData({
        await: () => [
            this.allMutations,
            this.selectedGeneticProfiles,
            this.geneticData,
            this.defaultOQLQuery
        ],
        invoke: async() => {

            const filteredGeneticDataByGene = _.groupBy(this.geneticData.result, (item: GeneMolecularData) => item.gene.hugoGeneSymbol);

            // now merge alterations with mutations by gene
            const mergedAlterationsByGene = _.mapValues(this.allMutations.result, (mutations: Mutation[], gene: string) => {
                // if for some reason it doesn't exist, assign empty array;
                return (gene in filteredGeneticDataByGene) ? _.concat(([] as (Mutation|GeneMolecularData)[]), mutations, filteredGeneticDataByGene[gene]) : [];
            });
            const ret = _.mapValues(mergedAlterationsByGene, (mutations: (Mutation|GeneMolecularData)[]) => {
                return filterCBioPortalWebServiceData(this.oqlQuery, mutations, (new accessors(this.selectedGeneticProfiles.result!)), this.defaultOQLQuery.result!)
            });

            return ret;
        }
    });

    readonly defaultOQLQuery = remoteData({
        await: () => [this.selectedGeneticProfiles],
        invoke: () => {
            const all_profile_types = _.map(this.selectedGeneticProfiles.result,(profile)=>profile.molecularAlterationType);
            var default_oql_uniq: any = {};
            for (var i = 0; i < all_profile_types.length; i++) {
                var type = all_profile_types[i];
                switch (type) {
                    case "MUTATION_EXTENDED":
                        default_oql_uniq["MUT"] = true;
                        default_oql_uniq["FUSION"] = true;
                        break;
                    case "COPY_NUMBER_ALTERATION":
                        default_oql_uniq["AMP"] = true;
                        default_oql_uniq["HOMDEL"] = true;
                        break;
                    case "MRNA_EXPRESSION":
                        default_oql_uniq["EXP>=" + this.zScoreThreshold] = true;
                        default_oql_uniq["EXP<=-" + this.zScoreThreshold] = true;
                        break;
                    case "PROTEIN_LEVEL":
                        default_oql_uniq["PROT>=" + this.rppaScoreThreshold] = true;
                        default_oql_uniq["PROT<=-" + this.rppaScoreThreshold] = true;
                        break;
                }
            }
            return Promise.resolve(Object.keys(default_oql_uniq).join(" "));
        }

    });

    readonly filteredAlterationsAsSampleIdArrays = remoteData({
        await: () => [
            this.filteredAlterations
        ],
        invoke: async() => {
            return _.mapValues(this.filteredAlterations.result, (mutations: Mutation[]) => _.map(mutations, 'sampleId'));
        }
    });

    readonly isSampleAlteredMap = remoteData({
        await: () => [this.filteredAlterationsAsSampleIdArrays, this.samples],
        invoke: async() => {
            return _.mapValues(this.filteredAlterationsAsSampleIdArrays.result, (sampleIds: string[]) => {
                return this.samples.result.map((sample: Sample) => {
                    return _.includes(sampleIds, sample.sampleId);
                });
            });
        }
    });

    readonly genes = remoteData(async() => {
        if (this.hugoGeneSymbols) {
            return client.fetchGenesUsingPOST({
                geneIds: this.hugoGeneSymbols.slice(),
                geneIdType: "HUGO_GENE_SYMBOL"
            });
        }
        return undefined;
    });

    readonly studyToSampleIds = remoteData<{[studyId:string]:{[sampleId:string]:boolean}}>(async()=>{
        const sampleListsToQuery:{studyId:string, sampleListId:string}[] = [];
        const ret:{[studyId:string]:{[sampleId:string]:boolean}} = {};
        for (const sampleSpec of this.samplesSpecification) {
            if (sampleSpec.sampleId) {
                ret[sampleSpec.studyId] = ret[sampleSpec.studyId] || {};
                ret[sampleSpec.studyId][sampleSpec.sampleId] = true;
            } else if (sampleSpec.sampleListId) {
                sampleListsToQuery.push(sampleSpec as {studyId:string, sampleListId:string});
            }
        }
        const results:string[][] = await Promise.all(sampleListsToQuery.map(spec=>{
            return client.getAllSampleIdsInSampleListUsingGET({
                sampleListId: spec.sampleListId
            });
        }));
        for (let i=0; i<results.length; i++) {
            ret[sampleListsToQuery[i].studyId] = ret[sampleListsToQuery[i].studyId] || {};
            const sampleMap = ret[sampleListsToQuery[i].studyId];
            results[i].map(sampleId=>{
                sampleMap[sampleId] = true;
            });
        }
        return ret;
    }, {});

    @computed get studyToSampleListId():{[studyId:string]:string} {
        return this.samplesSpecification.reduce((map, next)=>{
            if (next.sampleListId) {
                map[next.studyId] = next.sampleListId;
            }
            return map;
        }, {} as {[studyId:string]:string});
    }

    readonly studyToMutationMolecularProfile = remoteData<{[studyId:string]:MolecularProfile}>({
        await: () => [
            this.molecularProfilesInStudies
        ],
        invoke: ()=>{
            const ret:{[studyId:string]:MolecularProfile} = {};
            for (const profile of this.molecularProfilesInStudies.result) {
                const studyId = profile.studyId;
                if (!ret[studyId] && isMutationProfile(profile)) {
                    ret[studyId] = profile;
                }
            }
            return Promise.resolve(ret);
        }
    }, {});

    @computed get studyIds():string[] {
        return Object.keys(this.studyToSampleIds.result);
    }

    @computed get myCancerGenomeData() {
        return fetchMyCancerGenomeData();
    }

    protected mutationMapperStores: {[hugoGeneSymbol: string]: MutationMapperStore} = {};

    public getMutationMapperStore(hugoGeneSymbol:string): MutationMapperStore|undefined
    {
        if (this.mutationMapperStores[hugoGeneSymbol]) {
            return this.mutationMapperStores[hugoGeneSymbol];
        }
        else if (!this.hugoGeneSymbols || !this.hugoGeneSymbols.find((gene:string) => gene === hugoGeneSymbol)) {
            return undefined;
        }
        else {
            const store = new MutationMapperStore(AppConfig,
                hugoGeneSymbol,
                this.samples,
                ()=>(this.mutationDataCache),
                this.molecularProfileIdToMolecularProfile,
                this.clinicalDataForSamples,
                this.studiesForSamplesWithoutCancerTypeClinicalData,
                this.samplesWithoutCancerTypeClinicalData,
                this.germlineConsentedSamples);

            this.mutationMapperStores[hugoGeneSymbol] = store;

            return store;
        }
    }

    readonly clinicalDataForSamples = remoteData<ClinicalData[]>({
        await: () => [
            this.samples
        ],
        invoke: () => {
            const filter:ClinicalDataMultiStudyFilter = {
                attributeIds: ["CANCER_TYPE", "CANCER_TYPE_DETAILED"],
                identifiers: this.samples.result.map((s:Sample)=>({entityId:s.sampleId, studyId:s.studyId}))
            };
            return client.fetchClinicalDataUsingPOST({
                clinicalDataType: "SAMPLE",
                clinicalDataMultiStudyFilter: filter,
                projection: "DETAILED"
            });
        }
    }, []);

    readonly germlineConsentedSamples = remoteData<SampleIdentifier[]>({
        invoke: async () => {
            const studies:string[] = this.studyIds;
            const ids:string[][] = await Promise.all(studies.map(studyId=>{
                return client.getAllSampleIdsInSampleListUsingGET({
                    sampleListId: this.getGermlineSampleListId(studyId)
                });
            }));
            return _.flatten(ids.map((sampleIds:string[], index:number)=>{
                const studyId = studies[index];
                return sampleIds.map(sampleId=>({sampleId, studyId}));
            }));
        },
        onError: () => {
            // fail silently
        }
    }, []);

    readonly samples = remoteData({
        await: () => [
            this.studyToSampleIds
        ],
        invoke: () => {
            let sampleIdentifiers:SampleIdentifier[] = [];
            _.each(this.studyToSampleIds.result, (sampleIds:{[sampleId:string]:boolean}, studyId:string)=>{
                sampleIdentifiers = sampleIdentifiers.concat(Object.keys(sampleIds).map(sampleId=>({sampleId, studyId})));
            });
            return client.fetchSamplesUsingPOST({
                sampleIdentifiers,
                projection: "DETAILED"
            });
        }
    }, []);

    readonly samplesWithoutCancerTypeClinicalData = remoteData<Sample[]>({
        await: () => [
            this.samples,
            this.clinicalDataForSamples
        ],
        invoke: () => {
            const sampleHasData:{[sampleUid:string]:boolean} = {};
            for (const data of this.clinicalDataForSamples.result) {
                sampleHasData[toSampleUuid(data.clinicalAttribute.studyId, data.entityId)] = true;
            }
            return Promise.resolve(this.samples.result.filter(sample=>{
                return !sampleHasData[toSampleUuid(sample.studyId, sample.sampleId)];
            }));
        }
    }, []);

    readonly studiesForSamplesWithoutCancerTypeClinicalData = remoteData({
        await: () => [
            this.samplesWithoutCancerTypeClinicalData
        ],
        invoke: async () => fetchStudiesForSamplesWithoutCancerTypeClinicalData(this.samplesWithoutCancerTypeClinicalData)
    }, []);

    readonly studies = remoteData({
        invoke: ()=>Promise.all(this.studyIds.map(studyId=>client.getStudyUsingGET({studyId})))
    }, []);

    private getGermlineSampleListId(studyId:string):string {
        return `${studyId}_germline`;
    }

    readonly molecularProfilesInStudies = remoteData<MolecularProfile[]>({
        invoke:async()=>{
            return _.flatten(await Promise.all(this.studyIds.map(studyId=>{
                return client.getAllMolecularProfilesInStudyUsingGET({
                    studyId
                });
            })));
        }
    }, []);

    readonly molecularProfileIdToMolecularProfile = remoteData<{[molecularProfileId:string]:MolecularProfile}>({
        await:()=>[this.molecularProfilesInStudies],
        invoke:()=>{
            return Promise.resolve(this.molecularProfilesInStudies.result.reduce((map:{[molecularProfileId:string]:MolecularProfile}, next:MolecularProfile)=>{
                map[next.molecularProfileId] = next;
                return map;
            }, {}));
        }
    }, {});

    readonly studyToMolecularProfileDiscrete = remoteData<{[studyId:string]:MolecularProfile}>({
        await: () => [
            this.molecularProfilesInStudies
        ],
        invoke: async () => {
            const ret:{[studyId:string]:MolecularProfile} = {};
            for (const molecularProfile of this.molecularProfilesInStudies.result) {
                if (molecularProfile.datatype === "DISCRETE") {
                    ret[molecularProfile.studyId] = molecularProfile;
                }
            }
            return ret;
        }
    }, {});

    readonly discreteCNAData = remoteData<DiscreteCopyNumberData[]>({
        await: () => [
            this.studyToMolecularProfileDiscrete,
            this.studyToDataQueryFilter
        ],
        invoke: async () => {
            const studies = this.studyIds;
            const results:DiscreteCopyNumberData[][] = await Promise.all(studies.map(studyId=>{
                const filter = this.studyToDataQueryFilter.result[studyId];
                const profile = this.studyToMolecularProfileDiscrete.result[studyId];
                if (filter && profile) {
                    return client.fetchDiscreteCopyNumbersInMolecularProfileUsingPOST({
                        projection: "DETAILED",
                        discreteCopyNumberFilter: filter as DiscreteCopyNumberFilter,
                        molecularProfileId: profile.molecularProfileId
                    });
                } else {
                    return Promise.resolve([]);
                }
            }));
            return _.flatten(results);
        },
        onResult: (result:DiscreteCopyNumberData[]) => {
            // We want to take advantage of this loaded data, and not redownload the same data
            //  for users of the cache
            this.discreteCNACache.addData(result);
        }

    }, []);

    readonly studyToDataQueryFilter = remoteData<{[studyId:string]:IDataQueryFilter}>({
        await: ()=>[this.studyToSampleIds],
        invoke:()=>{
            const studies = this.studyIds;
            const ret:{[studyId:string]:IDataQueryFilter} = {};
            for (const studyId of studies) {
                ret[studyId] = generateDataQueryFilter(this.studyToSampleListId[studyId]||null, Object.keys(this.studyToSampleIds.result[studyId] || {}))
            }
            return Promise.resolve(ret);
        }
    }, {});

    // @computed get mergedDiscreteCNAData():DiscreteCopyNumberData[][] {
    //     return mergeDiscreteCNAData(this.discreteCNAData);
    // }

    @cached get oncoKbEvidenceCache() {
        return new OncoKbEvidenceCache();
    }

    @cached get pubMedCache() {
        return new PubMedCache();
    }

    @cached get discreteCNACache() {
        return new DiscreteCNACache(this.studyToMolecularProfileDiscrete.result);
    }

    @cached get cancerTypeCache() {
        return new CancerTypeCache();
    }

    @cached get mutationCountCache() {
        return new MutationCountCache();
    }

    @cached get pdbHeaderCache() {
        return new PdbHeaderCache();
    }

    @cached get mutationDataCache() {
        return new MutationDataCache(this.studyToMutationMolecularProfile.result,
                                    this.studyToDataQueryFilter.result);
    }

    @action clearErrors() {
        this.ajaxErrors = [];
    }
}
